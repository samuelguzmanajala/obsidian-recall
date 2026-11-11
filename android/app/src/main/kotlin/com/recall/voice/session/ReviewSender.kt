package com.recall.voice.session

import com.recall.voice.api.ReviewResult
import com.recall.voice.api.ReviewSubmit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext

/** What the session needs to know about unconfirmed work. */
data class SenderStatus(
  /** Commands in the journal, not yet confirmed or rejected. */
  val pending: Int = 0,
  /** Failed attempts since the last answer from the server; 0 when healthy. */
  val consecutiveFailures: Int = 0,
  val lastFailure: String? = null,
)

/** 1 s, 2 s, 4 s … capped at 30 s. */
fun reviewBackoffMs(failures: Int): Long = (1000L shl (failures - 1).coerceIn(0, 5)).coerceAtMost(30_000L)

/**
 * The single background sender of a session: drains the journal in order, one command at a time,
 * retrying failures forever with the same operationId. It never drops a command; only a server
 * rejection removes one (and [ReviewOutbox] archives it first).
 */
class ReviewSender(
  private val outbox: ReviewOutbox,
  private val post: suspend (List<ReviewSubmit>) -> ReviewResult,
  private val onOutcome: (SendOutcome) -> Unit,
  private val backoffMs: (Int) -> Long = ::reviewBackoffMs,
) {
  private val _status = MutableStateFlow(SenderStatus())
  val status: StateFlow<SenderStatus> = _status.asStateFlow()
  private val wake = Channel<Unit>(Channel.CONFLATED)

  /** Reads what an earlier session left in the journal. Call before [run]. */
  suspend fun loadPending() {
    val pending = outbox.pendingCount()
    _status.update { it.copy(pending = pending) }
    if (pending > 0) wake.trySend(Unit)
  }

  /**
   * Commits [command] to the journal. Once called it completes even if the session is cancelled,
   * so a decision the user made is never only in memory.
   */
  suspend fun enqueue(command: ReviewSubmit) {
    val pending = withContext(NonCancellable) { outbox.enqueue(command) }
    _status.update { it.copy(pending = pending) }
    wake.trySend(Unit)
  }

  /** Runs until cancelled. */
  suspend fun run() {
    while (true) {
      wake.receive()
      drain()
    }
  }

  private suspend fun drain() {
    while (true) {
      val sentAt = Timing.now()
      val outcome = try {
        outbox.sendNext(post)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        val failures = _status.value.consecutiveFailures + 1
        _status.update { it.copy(consecutiveFailures = failures, lastFailure = e.message ?: e::class.java.simpleName) }
        Timing.log("review-confirm", sentAt, "failed #$failures ${e::class.java.simpleName}")
        delay(backoffMs(failures))
        continue
      } ?: return
      Timing.log(
        "review-confirm",
        sentAt,
        (if (outcome is SendOutcome.Confirmed) "confirmed" else "rejected") +
          (outcome.due?.let { " with-queue=${it.size}" } ?: " no-queue"),
      )
      onOutcome(outcome)
      val pending = runCatching { outbox.pendingCount() }.getOrDefault(_status.value.pending - 1).coerceAtLeast(0)
      _status.update { SenderStatus(pending = pending) }
    }
  }
}
