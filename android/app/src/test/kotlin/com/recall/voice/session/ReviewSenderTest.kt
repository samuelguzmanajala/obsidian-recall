package com.recall.voice.session

import com.recall.voice.api.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class ReviewSenderTest {
  @TempDir lateinit var directory: File
  private val url = "https://backend.example"
  private fun outbox() = ReviewOutbox(directory, url, Dispatchers.Unconfined)

  @Test fun `drains in order in the background and reports each outcome`() = runTest {
    val outcomes = mutableListOf<SendOutcome>()
    val posted = mutableListOf<String>()
    val sender = ReviewSender(outbox(), { posted += it.single().operationId; ReviewResult(1, emptyList()) }, { outcomes += it })
    sender.loadPending()
    val job = launch { sender.run() }
    sender.enqueue(ReviewSubmit("a", Rating.Good, "op-a"))
    sender.enqueue(ReviewSubmit("b", Rating.Easy, "op-b"))
    runCurrent()
    assertEquals(listOf("op-a", "op-b"), posted)
    assertEquals(listOf("op-a", "op-b"), outcomes.map { it.command.operationId })
    assertTrue(outcomes.all { it is SendOutcome.Confirmed })
    assertEquals(SenderStatus(pending = 0), sender.status.value)
    job.cancel()
  }

  @Test fun `transport failures retry the same command with backoff and never drop it`() = runTest {
    var online = false
    val attempts = mutableListOf<String>()
    val sender = ReviewSender(outbox(), {
      attempts += it.single().operationId
      if (!online) throw IOException("Offline")
      ReviewResult(1, emptyList())
    }, {}, backoffMs = { 1_000L })
    val job = launch { sender.run() }
    sender.enqueue(ReviewSubmit("a", Rating.Good, "op-a"))
    runCurrent()
    assertEquals(1, sender.status.value.consecutiveFailures)
    advanceTimeBy(1_001); runCurrent()
    advanceTimeBy(1_001); runCurrent()
    assertEquals(3, sender.status.value.consecutiveFailures)
    assertEquals(CardGate.Stop, cardGate(sender.status.value.pending, sender.status.value.consecutiveFailures))
    assertEquals(1, outbox().pendingCount())
    online = true
    advanceTimeBy(1_001); runCurrent()
    assertEquals(List(4) { "op-a" }, attempts)
    assertEquals(SenderStatus(pending = 0), sender.status.value)
    job.cancel()
  }

  @Test fun `a server error that is not a rejection keeps the command queued`() = runTest {
    val sender = ReviewSender(outbox(), { throw ApiException(503, "busy") }, {}, backoffMs = { 60_000L })
    val job = launch { sender.run() }
    sender.enqueue(ReviewSubmit("a", Rating.Good, "op-a"))
    runCurrent()
    assertEquals(1, sender.status.value.pending)
    assertEquals(1, sender.status.value.consecutiveFailures)
    assertEquals(1, outbox().pendingCount())
    job.cancel()
  }

  @Test fun `a rejection is archived, reported, and the session continues with the next`() = runTest {
    val outcomes = mutableListOf<SendOutcome>()
    val sender = ReviewSender(outbox(), {
      if (it.single().operationId == "op-a") ReviewResult(0, listOf(ReviewError(0, "Card is no longer due", 409)))
      else ReviewResult(1, emptyList())
    }, { outcomes += it })
    val job = launch { sender.run() }
    sender.enqueue(ReviewSubmit("a", Rating.Good, "op-a"))
    sender.enqueue(ReviewSubmit("b", Rating.Good, "op-b"))
    runCurrent()
    assertTrue(outcomes[0] is SendOutcome.Rejected)
    assertTrue(outcomes[1] is SendOutcome.Confirmed)
    assertEquals(1, outbox().rejectedCount())
    assertEquals(0, sender.status.value.consecutiveFailures)
    job.cancel()
  }

  @Test fun `work left by an earlier session is picked up on start`() = runTest {
    outbox().enqueue(ReviewSubmit("a", Rating.Good, "op-a"))
    val posted = mutableListOf<String>()
    val sender = ReviewSender(outbox(), { posted += it.single().operationId; ReviewResult(1, emptyList()) }, {})
    sender.loadPending()
    assertEquals(1, sender.status.value.pending)
    val job = launch { sender.run() }
    runCurrent()
    assertEquals(listOf("op-a"), posted)
    assertEquals(0, sender.status.value.pending)
    job.cancel()
  }

  @Test fun `cancelling the session keeps an enqueued review in the journal`() = runTest {
    val sender = ReviewSender(outbox(), { throw IOException("Offline") }, {}, backoffMs = { 60_000L })
    val job = launch { sender.run() }
    sender.enqueue(ReviewSubmit("a", Rating.Good, "op-a"))
    runCurrent()
    job.cancel(); runCurrent()
    assertEquals(listOf("op-a"), outbox().pending().map { it.operationId })
  }

  @Test fun `backoff grows and is capped`() {
    assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), (1..7).map(::reviewBackoffMs))
  }
}
