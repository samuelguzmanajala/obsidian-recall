package com.recall.voice.session

import com.recall.voice.api.Rating

/** A missing recognition result can only pause; it can never become a rating. */
suspend fun awaitVoiceDecision(listen: suspend () -> Rating?, awaitResume: suspend () -> Unit): Rating {
  while (true) {
    val rating = listen()
    if (rating != null) return rating
    awaitResume()
  }
}
