package com.recall.voice.session

import com.recall.voice.api.*
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.io.IOException

class ReviewOutboxTest {
  @TempDir lateinit var directory: File
  private val url = "https://backend.example"

  @Test fun `lost acknowledgement is recovered after reconstruction exactly once`() = runTest {
    val command = ReviewSubmit("card", Rating.Good, "stable-operation", 2)
    val accepted = mutableSetOf<String>()
    var failed = false
    try {
      ReviewOutbox(directory, url).send(command) { commands ->
        accepted.add(commands.single().operationId)
        throw IOException("Lost response")
      }
    } catch (_: IOException) { failed = true }
    assertTrue(failed)
    ReviewOutbox(directory, url).recover { commands ->
      assertEquals(command, commands.single())
      accepted.add(commands.single().operationId)
      ReviewResult(1, emptyList())
    }
    assertEquals(1, accepted.size)
    ReviewOutbox(directory, url).recover { fail("No command should remain") }
  }

  @Test fun `storage failure prevents network submission`() = runTest {
    val invalidDirectory = File(directory, "file-not-directory").apply { writeText("occupied") }
    var sent = false
    try {
      ReviewOutbox(invalidDirectory, url).send(ReviewSubmit("card", Rating.Good)) {
        sent = true; ReviewResult(1, emptyList())
      }
      fail("Expected storage failure")
    } catch (_: IllegalStateException) { }
    assertFalse(sent)
  }

  @Test fun `pending commands cannot leak to another server`() = runTest {
    try { ReviewOutbox(directory, url).send(ReviewSubmit("card", Rating.Good)) { throw IOException("Offline") } }
    catch (_: IOException) { }
    ReviewOutbox(directory, "https://different.example").recover { fail("Wrong server") }
  }

  @Test fun `a definitive conflict is archived and does not block future recovery`() = runTest {
    val outbox = ReviewOutbox(directory, url)
    try {
      outbox.send(ReviewSubmit("card", Rating.Good)) {
        ReviewResult(0, listOf(ReviewError(0, "Stale revision", 409)))
      }
      fail("Expected explicit rejection")
    } catch (_: IllegalStateException) { }
    assertEquals(1, outbox.rejectedCount())
    ReviewOutbox(directory, url).recover { fail("Rejected decision must not be resubmitted") }
  }

  @Test fun `corrupt storage fails closed instead of clearing the journal`() = runTest {
    try { ReviewOutbox(directory, url).send(ReviewSubmit("card", Rating.Good)) { throw IOException("Offline") } }
    catch (_: IOException) { }
    val file = directory.listFiles()!!.single { it.name.startsWith("pending-") && it.extension == "json" }
    file.writeText("not valid JSON")
    var sent = false
    try { ReviewOutbox(directory, url).recover { sent = true; ReviewResult(1, emptyList()) }; fail("Expected error") }
    catch (_: kotlinx.serialization.SerializationException) { }
    assertFalse(sent)
    assertEquals("not valid JSON", file.readText())
  }
}
