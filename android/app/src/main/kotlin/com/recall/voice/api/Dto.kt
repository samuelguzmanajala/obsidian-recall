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

@Serializable
internal data class ReviewsRequest(val reviews: List<ReviewSubmit>)

@Serializable
data class ReviewError(val idx: Int, val reason: String, val status: Int? = null)

@Serializable
data class ReviewResult(val applied: Int, val errors: List<ReviewError>)

@Serializable
internal data class DecksResponse(val decks: List<DeckTreeNode>)

@Serializable
internal data class DueResponse(val items: List<DueItem>)
