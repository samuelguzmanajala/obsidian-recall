package com.recall.voice.session

import com.recall.voice.api.DueItem
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class QueueReconcileTest {
  private fun item(id: String, concept: String = "c-$id", revision: Int? = 0, voice: String = "q") = DueItem(
    studyItemId = id, conceptId = concept, sideA = "a", sideB = "b", direction = "a-to-b", due = "2026-11-11",
    reps = 1, lapses = 0, stability = 1.0, difficulty = 5.0, voiceQuestion = voice, voiceAnswer = "a", revision = revision,
  )
  private fun ids(items: List<DueItem>) = items.map { it.studyItemId }

  @Test fun `keeps retained order, drops what is no longer due, appends new`() {
    val buffer = listOf(item("a"), item("b"), item("c"))
    val fresh = listOf(item("d"), item("c"), item("a"), item("e"))
    assertEquals(listOf("a", "c", "d", "e"), ids(reconcileQueue(buffer, fresh, null, emptyList(), freshComplete = true)))
  }

  @Test fun `retained items take the fresh copy`() {
    val fresh = listOf(item("a", revision = 4, voice = "edited"))
    val out = reconcileQueue(listOf(item("a", revision = 3)), fresh, null, emptyList(), freshComplete = true)
    assertEquals(4, out.single().revision)
    assertEquals("edited", out.single().voiceQuestion)
  }

  @Test fun `a truncated answer does not drop items it may simply not include`() {
    val buffer = listOf(item("a"), item("b"))
    assertEquals(listOf("a", "b"), ids(reconcileQueue(buffer, listOf(item("a"), item("c")), null, emptyList(), freshComplete = false)))
  }

  @Test fun `a truncated answer never grows the session, unless the queue ran out`() {
    val fresh = listOf(item("b"), item("x"), item("y"))
    assertEquals(listOf("a", "b"), ids(reconcileQueue(listOf(item("a"), item("b")), fresh, null, emptyList(), freshComplete = false)))
    assertEquals(listOf("b", "x", "y"), ids(reconcileQueue(emptyList(), fresh, null, emptyList(), freshComplete = false, appendNew = true)))
  }

  @Test fun `never queues the card on screen or its other direction`() {
    val current = item("x", concept = "k")
    val fresh = listOf(item("x", concept = "k"), item("y", concept = "k"), item("z"))
    assertEquals(listOf("z"), ids(reconcileQueue(emptyList(), fresh, current, emptyList(), freshComplete = true)))
  }

  @Test fun `never queues a card whose review is pending, nor a stale copy of a confirmed one`() {
    val reviewed = listOf(ReviewedCard("p", "c-p", 2))
    // The server has not applied the review yet (or answered before it did): same revision.
    assertEquals(emptyList<String>(), ids(reconcileQueue(emptyList(), listOf(item("p", revision = 2)), null, reviewed, true)))
    // It applied it and the card is due again (e.g. after Again): newer revision, queue it.
    assertEquals(listOf("p"), ids(reconcileQueue(emptyList(), listOf(item("p", revision = 3)), null, reviewed, true)))
    // Without revisions the client cannot tell, so it stays out.
    assertEquals(emptyList<String>(), ids(reconcileQueue(emptyList(), listOf(item("p", revision = null)), null, listOf(ReviewedCard("p", "c-p", null)), true)))
  }

  @Test fun `never queues the other direction of a card reviewed in this session`() {
    val reviewed = listOf(ReviewedCard("fwd", "k", 0))
    val fresh = listOf(item("rev", concept = "k"), item("other"))
    assertEquals(listOf("other"), ids(reconcileQueue(emptyList(), fresh, null, reviewed, true)))
  }

  @Test fun `duplicates in the server answer are queued once`() {
    assertEquals(listOf("a"), ids(reconcileQueue(emptyList(), listOf(item("a"), item("a")), null, emptyList(), true)))
  }

  @Test fun `dropSiblings removes both directions of the rated concept`() {
    val rated = item("fwd", concept = "k")
    val buffer = listOf(item("rev", concept = "k"), item("a"), item("b", concept = "k"))
    assertEquals(listOf("a"), ids(dropSiblings(buffer, rated)))
  }
}
