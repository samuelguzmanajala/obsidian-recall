package com.recall.voice.session

import com.recall.voice.api.DueItem
import com.recall.voice.api.Rating

sealed interface SessionState {
  data object Idle : SessionState
  data object Fetching : SessionState
  data class ReadingQuestion(val item: DueItem, val index: Int, val total: Int) : SessionState
  data class ListeningReveal(val item: DueItem, val index: Int, val total: Int) : SessionState
  data class ReadingAnswer(val item: DueItem, val index: Int, val total: Int) : SessionState
  data class ListeningRating(val item: DueItem, val index: Int, val total: Int) : SessionState
  data class AwaitingConfirmation(val item: DueItem, val index: Int, val total: Int) : SessionState
  data class Submitting(val item: DueItem, val rating: Rating, val index: Int, val total: Int) : SessionState
  data class Done(val totalReviewed: Int) : SessionState
  data class Error(val message: String) : SessionState
}

/** Convenience: extract the current item if any. */
val SessionState.currentItem: DueItem?
  get() = when (this) {
    is SessionState.ReadingQuestion -> item
    is SessionState.ListeningReveal -> item
    is SessionState.ReadingAnswer -> item
    is SessionState.ListeningRating -> item
    is SessionState.AwaitingConfirmation -> item
    is SessionState.Submitting -> item
    else -> null
  }
