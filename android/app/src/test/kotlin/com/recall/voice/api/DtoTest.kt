package com.recall.voice.api

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DtoTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test fun `Rating round-trips with lowercase string serialization`() {
    val r = Rating.Good
    val text = json.encodeToString(r)
    assertEquals("\"good\"", text)
    val back = json.decodeFromString<Rating>(text)
    assertEquals(Rating.Good, back)
  }

  @Test fun `ReviewSubmit serializes with rating as string`() {
    val s = ReviewSubmit(studyItemId = "abc", rating = Rating.Easy)
    val text = json.encodeToString(s)
    assertTrue(text.contains("\"studyItemId\":\"abc\""))
    assertTrue(text.contains("\"rating\":\"easy\""))
  }

  @Test fun `ReviewsRequest matches the server contract`() {
    val req = ReviewsRequest(listOf(ReviewSubmit("id-1", Rating.Again, "op-1", 4)))
    val text = json.encodeToString(req)
    assertEquals("""{"reviews":[{"studyItemId":"id-1","rating":"again","operationId":"op-1","expectedRevision":4}]}""", text)
  }

  @Test fun `reviews body with an all-decks queue omits deckId`() {
    val reviews = listOf(ReviewSubmit("id-1", Rating.Good, "op-1", 4))
    val expected = """{"reviews":[{"studyItemId":"id-1","rating":"good","operationId":"op-1","expectedRevision":4}],"due":{"limit":200}}"""
    assertEquals(expected, reviewsRequestBody(reviews, DueRequest.of(null, 200)))
    // A blank deck means all decks too: the server would reject "" with a 400.
    assertEquals(expected, reviewsRequestBody(reviews, DueRequest.of("", 200)))
    assertEquals(expected, reviewsRequestBody(reviews, DueRequest.of("  ", 200)))
  }

  @Test fun `reviews body with a single-deck queue carries deckId`() {
    val reviews = listOf(ReviewSubmit("id-1", Rating.Good, "op-1", 4))
    assertEquals(
      """{"reviews":[{"studyItemId":"id-1","rating":"good","operationId":"op-1","expectedRevision":4}],"due":{"deckId":"deck-7","limit":200}}""",
      reviewsRequestBody(reviews, DueRequest.of("deck-7", 200)),
    )
  }

  @Test fun `reviews body without a queue is unchanged`() {
    assertEquals(
      """{"reviews":[{"studyItemId":"id-1","rating":"again","operationId":"op-1","expectedRevision":4}]}""",
      reviewsRequestBody(listOf(ReviewSubmit("id-1", Rating.Again, "op-1", 4))),
    )
  }

  @Test fun `a due request outside the server's limit cannot be built`() {
    for (limit in listOf(0, -1, DUE_LIMIT_MAX + 1)) {
      assertThrows(IllegalArgumentException::class.java) { DueRequest.of(null, limit) }
    }
    DueRequest.of(null, 1); DueRequest.of("d", DUE_LIMIT_MAX)
  }

  @Test fun `review result decodes with and without a queue`() {
    val without = decodeReviewResult("""{"applied":1,"errors":[]}""")
    assertEquals(ReviewResult(1, emptyList()), without)
    assertNull(without.due)

    val with = decodeReviewResult(
      """{"applied":0,"errors":[{"idx":0,"reason":"Stale revision","status":409}],
          "due":{"items":[{"studyItemId":"x","conceptId":"y","sideA":"a","sideB":"b","direction":"a-to-b",
          "due":"2026-01-01T00:00:00.000Z","reps":0,"lapses":0,"stability":0.0,"difficulty":0.0,
          "voiceQuestion":"a","voiceAnswer":"b","revision":3,"extra":"ignored"}]}}""",
    )
    assertEquals(listOf(ReviewError(0, "Stale revision", 409)), with.errors)
    assertEquals(listOf("x"), with.due!!.items.map { it.studyItemId })
    assertEquals(3, with.due!!.items.single().revision)

    assertEquals(emptyList<DueItem>(), decodeReviewResult("""{"applied":1,"errors":[],"due":{"items":[]}}""").due!!.items)
  }

  @Test fun `DueItem can deserialize a real server payload`() {
    val payload = """
      {
        "studyItemId":"678e9302",
        "conceptId":"7e962847",
        "sideA":"neglect",
        "sideB":"descuidar",
        "direction":"b-to-a",
        "due":"2026-03-12T23:00:00.000Z",
        "reps":2,
        "lapses":0,
        "stability":2.148,
        "difficulty":7.04,
        "lastReview":"2026-03-10T23:00:00.000Z",
        "voiceQuestion":"descuidar",
        "voiceAnswer":"neglect"
      }
    """.trimIndent()
    val item = json.decodeFromString<DueItem>(payload)
    assertEquals("678e9302", item.studyItemId)
    assertEquals("descuidar", item.voiceQuestion)
    assertEquals(2.148, item.stability, 0.001)
  }

  @Test fun `DueItem tolerates null lastReview`() {
    val payload = """
      {"studyItemId":"x","conceptId":"y","sideA":"a","sideB":"b","direction":"a-to-b",
       "due":"2026-01-01T00:00:00.000Z","reps":0,"lapses":0,"stability":0.0,"difficulty":0.0,
       "lastReview":null,"voiceQuestion":"a","voiceAnswer":"b"}
    """.trimIndent().replace("\n", " ")
    val item = json.decodeFromString<DueItem>(payload)
    assertEquals(null, item.lastReview)
  }

  @Test fun `DeckTreeNode deserializes nested children`() {
    val payload = """
      {"id":"r","name":"German","totalItems":1018,"dueItems":909,"newItems":110,
       "children":[{"id":"c","name":"vocabulary","totalItems":739,"dueItems":644,"newItems":109,"children":[]}]}
    """.trimIndent().replace("\n", " ")
    val node = json.decodeFromString<DeckTreeNode>(payload)
    assertEquals("German", node.name)
    assertEquals(1, node.children.size)
    assertEquals("vocabulary", node.children[0].name)
  }

  private fun assertEquals(expected: Double, actual: Double, delta: Double) {
    assertTrue(kotlin.math.abs(expected - actual) <= delta, "expected $expected ± $delta but was $actual")
  }
}
