package com.recall.voice.session

import com.recall.voice.api.ReviewSubmit
import com.recall.voice.api.ReviewResult
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

/** One journal per backend. Never store tokens; never send before durable save. */
class ReviewOutbox(directory: File, backendUrl: String) {
  private val json = Json { ignoreUnknownKeys = true }
  private val key = MessageDigest.getInstance("SHA-256")
    .digest(backendUrl.trim().trimEnd('/').toByteArray()).joinToString("") { "%02x".format(it) }
  private val file = File(directory, "pending-reviews-$key.json")
  private val rejectedFile = File(directory, "rejected-reviews-$key.json")
  fun rejectedCount(): Int = if (rejectedFile.exists()) json.decodeFromString<List<RejectedReview>>(rejectedFile.readText()).size else 0
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

  suspend fun send(command: ReviewSubmit, post: suspend (List<ReviewSubmit>) -> ReviewResult) = mutex.withLock {
    val pending = load().toMutableList()
    if (pending.none { it.operationId == command.operationId }) pending.add(command)
    save(pending)
    drain(pending, post)
  }

  suspend fun recover(post: suspend (List<ReviewSubmit>) -> ReviewResult) = mutex.withLock {
    drain(load().toMutableList(), post)
  }

  private suspend fun drain(pending: MutableList<ReviewSubmit>, post: suspend (List<ReviewSubmit>) -> ReviewResult) {
    while (pending.isNotEmpty()) {
      val result = post(listOf(pending.first()))
      if (result.errors.isNotEmpty()) {
        val error = result.errors.first()
        if (error.status in listOf(400, 404, 409, 422)) {
          val rejected = if (rejectedFile.exists()) json.decodeFromString<List<RejectedReview>>(rejectedFile.readText()) else emptyList()
          val command = pending.first()
          if (rejected.none { it.command.operationId == command.operationId }) {
            writeAtomic(rejectedFile, json.encodeToString(rejected + RejectedReview(command, error.reason)))
          }
          pending.removeAt(0); save(pending)
          throw IllegalStateException("Repaso rechazado y archivado, no aplicado: ${error.reason}")
        }
        throw IllegalStateException("Repaso pendiente de confirmacion: ${error.reason}")
      }
      check(result.applied == 1) { "Repaso pendiente de confirmacion" }
      pending.removeAt(0)
      save(pending)
    }
  }

  companion object { private val mutex = Mutex() }
}
