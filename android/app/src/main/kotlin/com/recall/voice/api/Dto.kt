package com.recall.voice.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class Rating {
  @SerialName("again") Again,
  @SerialName("hard") Hard,
  @SerialName("good") Good,
  @SerialName("easy") Easy,
}

@Serializable
data class DueItem(
  val studyItemId: String,
  val conceptId: String,
  val sideA: String,
  val sideB: String,
  val direction: String,
  val due: String,
  val reps: Int,
  val lapses: Int,
  val stability: Double,
  val difficulty: Double,
  val lastReview: String? = null,
  val voiceQuestion: String,
  val voiceAnswer: String,
  val preview: PreviewIntervals? = null,
  val revision: Int? = null,
)

@Serializable
data class PreviewIntervals(
  val againDays: Int,
  val hardDays: Int,
  val goodDays: Int,
  val easyDays: Int,
)

@Serializable
data class DeckTreeNode(
  val id: String,
  val name: String,
  val totalItems: Int,
  val dueItems: Int,
  val newItems: Int,
  val children: List<DeckTreeNode>,
)

@Serializable
data class ReviewSubmit(
  val studyItemId: String,
  val rating: Rating,
  val operationId: String = java.util.UUID.randomUUID().toString(),
  val expectedRevision: Int? = null,
)

/** Highest queue `limit` the server accepts (`dueLimit` in the backend); the lowest is 1. */
const val DUE_LIMIT_MAX = 10_000

/**
 * Optional `due` field of `POST /reviews`: asks the server to answer with the queue it computes
 * after the batch. An invalid one makes the whole request fail with 400, which the sender would
 * retry forever, so it can only be built valid: [limit] in 1..[DUE_LIMIT_MAX] and [deckId] either
 * absent (all decks) or non-blank. A null [deckId] is left out of the JSON (it is a default and
 * the API's `Json` does not encode defaults); the server rejects `null` and `""`.
 */
@Serializable
class DueRequest private constructor(val deckId: String? = null, val limit: Int) {
  init {
    require(limit in 1..DUE_LIMIT_MAX) { "due limit must be 1–$DUE_LIMIT_MAX" }
    require(deckId == null || deckId.isNotBlank()) { "due deckId must be absent or non-blank" }
  }

  companion object {
    /** The queue of [deckId], or of all decks when it is null or blank (same rule as `getDue`). */
    fun of(deckId: String?, limit: Int): DueRequest = DueRequest(deckId?.takeUnless { it.isBlank() }, limit)
  }
}

@Serializable
internal data class ReviewsRequest(val reviews: List<ReviewSubmit>, val due: DueRequest? = null)

@Serializable
data class ReviewError(val idx: Int, val reason: String, val status: Int? = null)

@Serializable
data class ReviewResult(
  val applied: Int,
  val errors: List<ReviewError>,
  /** The queue after the batch; present only when the request asked for it and the server supports it. */
  val due: DueResponse? = null,
)

@Serializable
internal data class DecksResponse(val decks: List<DeckTreeNode>)

@Serializable
data class DueResponse(val items: List<DueItem>)
