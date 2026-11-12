package com.recall.voice.session

import com.recall.voice.api.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.io.IOException

class ReviewOutboxTest {
  @TempDir lateinit var directory: File
  private val url = "https://backend.example"
  private fun outbox(dir: File = directory, backend: String = url) = ReviewOutbox(dir, backend, Dispatchers.Unconfined)
  private val ok: suspend (List<ReviewSubmit>) -> ReviewResult = { ReviewResult(1, emptyList()) }

  @Test fun `lost acknowledgement is recovered after reconstruction exactly once`() = runTest {
    val command = ReviewSubmit("card", Rating.Good, "stable-operation", 2)
    val accepted = mutableSetOf<String>()
    outbox().enqueue(command)
    try {
      outbox().sendNext { commands -> accepted.add(commands.single().operationId); throw IOException("Lost response") }
      fail("Expected transport failure")
    } catch (_: IOException) { }
    outbox().recover { commands ->
      assertEquals(command, commands.single())
      accepted.add(commands.single().operationId)
      ReviewResult(1, emptyList())
    }
    assertEquals(1, accepted.size)
    outbox().recover { fail("No command should remain") }
  }

  @Test fun `storage failure prevents queueing and network submission`() = runTest {
    val invalidDirectory = File(directory, "file-not-directory").apply { writeText("occupied") }
    val broken = outbox(invalidDirectory)
    try { broken.enqueue(ReviewSubmit("card", Rating.Good)); fail("Expected storage failure") }
    catch (_: IllegalStateException) { }
    var sent = false
    assertNull(broken.sendNext { sent = true; ReviewResult(1, emptyList()) })
    assertFalse(sent)
  }

  @Test fun `pending commands cannot leak to another server`() = runTest {
    outbox().enqueue(ReviewSubmit("card", Rating.Good))
    outbox(backend = "https://different.example").recover { fail("Wrong server") }
    assertEquals(1, outbox().pendingCount())
  }

  @Test fun `a definitive conflict is archived and does not block future recovery`() = runTest {
    val box = outbox()
    box.enqueue(ReviewSubmit("card", Rating.Good))
    try {
      box.recover { ReviewResult(0, listOf(ReviewError(0, "Stale revision", 409))) }
      fail("Expected explicit rejection")
    } catch (_: IllegalStateException) { }
    assertEquals(1, box.rejectedCount())
    outbox().recover { fail("Rejected decision must not be resubmitted") }
  }

  @Test fun `corrupt storage fails closed instead of clearing the journal`() = runTest {
    outbox().enqueue(ReviewSubmit("card", Rating.Good))
    val file = directory.listFiles()!!.single { it.name.startsWith("pending-") && it.extension == "json" }
    file.writeText("not valid JSON")
    var sent = false
    try { outbox().recover { sent = true; ReviewResult(1, emptyList()) }; fail("Expected error") }
    catch (_: kotlinx.serialization.SerializationException) { }
    try { outbox().enqueue(ReviewSubmit("other", Rating.Good)); fail("Expected error") }
    catch (_: kotlinx.serialization.SerializationException) { }
    assertFalse(sent)
    assertEquals("not valid JSON", file.readText())
  }

  // Enqueue / drain split

  @Test fun `enqueue is durable before any send and drains in order`() = runTest {
    val a = ReviewSubmit("a", Rating.Good, "op-a", 1)
    val b = ReviewSubmit("b", Rating.Hard, "op-b", 3)
    val c = ReviewSubmit("c", Rating.Easy, "op-c", 0)
    outbox().enqueue(a); outbox().enqueue(b); assertEquals(3, outbox().enqueue(c))
    // A new instance (as after process death) sees the same journal.
    assertEquals(listOf(a, b, c), outbox().pending())
    val sent = mutableListOf<String>()
    val box = outbox()
    while (true) {
      val outcome = box.sendNext { sent += it.single().operationId; ReviewResult(1, emptyList()) } ?: break
      assertTrue(outcome is SendOutcome.Confirmed)
    }
    assertEquals(listOf("op-a", "op-b", "op-c"), sent)
    assertEquals(0, box.pendingCount())
  }

  @Test fun `re-enqueueing the same operationId is idempotent`() = runTest {
    val command = ReviewSubmit("a", Rating.Good, "op-a", 1)
    assertEquals(1, outbox().enqueue(command))
    assertEquals(1, outbox().enqueue(command))
    assertEquals(listOf(command), outbox().pending())
    var posts = 0
    outbox().recover { posts++; ReviewResult(1, emptyList()) }
    assertEquals(1, posts)
  }

  @Test fun `a transport failure leaves the command queued with the same operationId`() = runTest {
    val command = ReviewSubmit("a", Rating.Good, "op-a", 1)
    val box = outbox()
    box.enqueue(command)
    repeat(3) {
      try { box.sendNext { throw IOException("Offline") }; fail("Expected transport failure") }
      catch (_: IOException) { }
    }
    assertEquals(listOf(command), box.pending())
    val outcome = box.sendNext { assertEquals("op-a", it.single().operationId); ReviewResult(1, emptyList()) }
    assertEquals(SendOutcome.Confirmed(command), outcome)
  }

  @Test fun `an unacknowledged answer is not treated as saved`() = runTest {
    val box = outbox()
    box.enqueue(ReviewSubmit("a", Rating.Good, "op-a"))
    try { box.sendNext { ReviewResult(0, listOf(ReviewError(0, "boom", 500))) }; fail() }
    catch (_: ReviewNotConfirmedException) { }
    try { box.sendNext { ReviewResult(0, emptyList()) }; fail() }
    catch (_: ReviewNotConfirmedException) { }
    assertEquals(1, box.pendingCount())
    assertEquals(0, box.rejectedCount())
  }

  @Test fun `a rejection is archived once, removed, and the next command still drains`() = runTest {
    val a = ReviewSubmit("a", Rating.Good, "op-a")
    val b = ReviewSubmit("b", Rating.Good, "op-b")
    val box = outbox()
    box.enqueue(a); box.enqueue(b)
    val first = box.sendNext { ReviewResult(0, listOf(ReviewError(0, "Other direction already reviewed today", 409))) }
    assertEquals(SendOutcome.Rejected(a, "Other direction already reviewed today"), first)
    assertEquals(1, box.rejectedCount())
    assertEquals(SendOutcome.Confirmed(b), box.sendNext(ok))
    assertNull(box.sendNext(ok))
    // Re-enqueueing and re-rejecting the same operation does not duplicate the archive.
    box.enqueue(a)
    box.sendNext { ReviewResult(0, listOf(ReviewError(0, "again", 404))) }
    assertEquals(1, box.rejectedCount())
  }

  @Test fun `every definitive status is archived, other statuses stay queued`() = runTest {
    val box = outbox()
    for (status in listOf(400, 404, 409, 422)) {
      val command = ReviewSubmit("card-$status", Rating.Good, "op-$status")
      box.enqueue(command)
      assertEquals(SendOutcome.Rejected(command, "no"), box.sendNext { ReviewResult(0, listOf(ReviewError(0, "no", status))) })
    }
    assertEquals(4, box.rejectedCount())
    box.enqueue(ReviewSubmit("card-503", Rating.Good, "op-503"))
    for (status in listOf(401, 500, 503, null)) {
      try { box.sendNext { ReviewResult(0, listOf(ReviewError(0, "no", status))) }; fail() }
      catch (_: ReviewNotConfirmedException) { }
    }
    assertEquals(1, box.pendingCount())
  }
}
