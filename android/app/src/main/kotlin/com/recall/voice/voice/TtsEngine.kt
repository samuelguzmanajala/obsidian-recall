package com.recall.voice.voice

import android.content.Context
import android.media.AudioManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Locale
import kotlin.coroutines.resume

class TtsEngine(context: Context) {

  private val initSignal = CompletableDeferred<Boolean>()
  private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
    initSignal.complete(status == TextToSpeech.SUCCESS)
  }

  /** Suspends until the engine is ready (or fails). Returns true on success. */
  suspend fun awaitInit(): Boolean = initSignal.await()

  /**
   * Speak [text] in [locale]. Suspends until the utterance finishes (or errors).
   * Returns true if the utterance played to completion, false otherwise.
   * Routes through STREAM_MUSIC so Bluetooth A2DP picks it up like media audio.
   */
  suspend fun speak(text: String, locale: Locale): Boolean = suspendCancellableCoroutine { cont ->
    val id = "u-${System.nanoTime()}"
    tts.language = locale
    tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {}
      override fun onDone(utteranceId: String?) {
        if (utteranceId == id && cont.isActive) cont.resume(true)
      }
      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?) {
        if (utteranceId == id && cont.isActive) cont.resume(false)
      }
      override fun onError(utteranceId: String?, errorCode: Int) {
        if (utteranceId == id && cont.isActive) cont.resume(false)
      }
    })
    val params = Bundle().apply {
      putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC)
    }
    val r = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, id)
    if (r != TextToSpeech.SUCCESS && cont.isActive) cont.resume(false)
    cont.invokeOnCancellation { runCatching { tts.stop() } }
  }

  fun shutdown() {
    runCatching { tts.stop() }
    runCatching { tts.shutdown() }
  }
}
