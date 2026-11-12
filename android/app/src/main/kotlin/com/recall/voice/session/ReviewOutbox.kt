package com.recall.voice.session

import com.recall.voice.api.ReviewSubmit
import com.recall.voice.api.ReviewResult
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

@Serializable
data class RejectedReview(val command: ReviewSubmit, val reason: String)

/** What the server said about the command at the head of the journal. */
sealed interface SendOutcome {
  val command: ReviewSubmit
  /** Applied by the server; removed from the journal. */
  data class Confirmed(override val command: ReviewSubmit) : SendOutcome
  /** Definitively refused (400/404/409/422); archived in the rejected file and removed from the journal. */
  data class Rejected(override val command: ReviewSubmit, val reason: String) : SendOutcome
}

/** The server answered but did not acknowledge the command; it stays in the journal. */
class ReviewNotConfirmedException(message: String) : IllegalStateException(message)

private val REJECTION_STATUSES = setOf(400, 404, 409, 422)

/**
 * One journal per backend. Never store tokens; never send before durable save.
 *
 * Writing ([enqueue]) and sending ([sendNext]) are separate so a decision can be committed to disk
 * and the session can move on while the network is slow. The network call never holds the file
 * lock, so an enqueue is never blocked behind a slow POST.
 */
class ReviewOutbox(
  directory: File,
  backendUrl: String,
  private val io: CoroutineDispatcher = Dispatchers.IO,
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val key = MessageDigest.getInstance("SHA-256")
    .digest(backendUrl.trim().trimEnd('/').toByteArray()).joinToString("") { "%02x".format(it) }
  private val file = File(directory, "pending-reviews-$key.json")
  private val rejectedFile = File(directory, "rejected-reviews-$key.json")
  fun rejectedCount(): Int = loadRejected().size
  private fun loadRejected(): List<RejectedReview> =
    if (rejectedFile.exists()) json.decodeFromString(rejectedFile.readText()) else emptyList()
  private fun load(): List<ReviewSubmit> =
    if (file.exists()) json.decodeFromString(file.readText()) else emptyList()

  private fun save(commands: List<ReviewSubmit>) {
    writeAtomic(file, json.encodeToString(commands))
  }
  private fun writeAtomic(file: File, content: String) {
    check(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs()) { "Cannot create review journal" }
    val temporary = File(file.parentFile, "${file.name}.tmp")
    FileOutputStream(temporary).use { stream ->
      stream.write(content.toByteArray())
      stream.fd.sync()
    }
    check(temporary.renameTo(file)) { "Cannot commit review journal" }
  }

  private suspend fun <T> journal(block: () -> T): T = fileLock.withLock { withContext(io) { block() } }

  /**
   * Durably appends [command] (fsync + atomic rename) unless a command with the same operationId
   * is already queued. Returns the number of queued commands. Throws if it cannot be stored, in
   * which case nothing was queued.
   */
  suspend fun enqueue(command: ReviewSubmit): Int = journal {
    val pending = load()
    if (pending.any { it.operationId == command.operationId }) pending.size
    else (pending + command).also(::save).size
  }

  suspend fun pendingCount(): Int = journal { load().size }

  suspend fun pending(): List<ReviewSubmit> = journal { load() }

  /**
   * Sends the oldest queued command. Returns null when the journal is empty.
   * Transport and unacknowledged failures throw and leave the command queued, so it is retried
   * later with the same operationId. Only one sender talks to the server at a time.
   */
  suspend fun sendNext(post: suspend (List<ReviewSubmit>) -> ReviewResult): SendOutcome? = sendLock.withLock {
    val head = journal { load().firstOrNull() } ?: return@withLock null
    val result = post(listOf(head))
    if (result.errors.isNotEmpty()) {
      val error = result.errors.first()
      if (error.status in REJECTION_STATUSES) {
        journal {
          // Archive before removing: a crash in between leaves a duplicate the archive ignores.
          val rejected = loadRejected()
          if (rejected.none { it.command.operationId == head.operationId }) {
            writeAtomic(rejectedFile, json.encodeToString(rejected + RejectedReview(head, error.reason)))
          }
          save(load().filterNot { it.operationId == head.operationId })
        }
        return@withLock SendOutcome.Rejected(head, error.reason)
      }
      throw ReviewNotConfirmedException("Repaso pendiente de confirmacion: ${error.reason}")
    }
    if (result.applied != 1) throw ReviewNotConfirmedException("Repaso pendiente de confirmacion")
    journal { save(load().filterNot { it.operationId == head.operationId }) }
    SendOutcome.Confirmed(head)
  }

  /**
   * Drains the whole journal. Used by the home screen: it stops at the first rejection (already
   * archived) by throwing, so the caller can report it; the next call continues with the rest.
   */
  suspend fun recover(post: suspend (List<ReviewSubmit>) -> ReviewResult) {
    while (true) {
      when (val outcome = sendNext(post) ?: return) {
        is SendOutcome.Confirmed -> Unit
        is SendOutcome.Rejected -> throw IllegalStateException("Repaso rechazado y archivado, no aplicado: ${outcome.reason}")
      }
    }
  }

  // Shared by every instance: the home screen and a session may hold different objects for the same file.
  companion object {
    private val fileLock = Mutex()
    private val sendLock = Mutex()
  }
}
