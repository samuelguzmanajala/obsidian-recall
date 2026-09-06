package com.recall.voice.voice

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import kotlin.coroutines.resume

class SttEngine(private val context: Context) {

  // Lazy so we don't allocate the tone generator until the first session.
  private val tone: ToneGenerator? by lazy {
    runCatching { ToneGenerator(AudioManager.STREAM_MUSIC, 80) }.getOrNull()
  }

  /**
   * Play a short "your turn" tone. Routed through STREAM_MUSIC so it reaches
   * the Bluetooth speaker the same way the TTS audio does.
   */
  fun playReadyTone() {
    runCatching { tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 120) }
  }

  /**
   * Listen for a single utterance for at most [timeoutMs] milliseconds.
   * Returns the best transcription, or null on timeout / error / silence.
   *
   * Must be called from a coroutine. Internally hops to the main thread
   * because SpeechRecognizer requires it.
   */
  suspend fun listenOnce(locale: Locale, timeoutMs: Long): String? {
    return withContext(Dispatchers.Main) {
      withTimeoutOrNull(timeoutMs) {
        suspendCancellableCoroutine { cont ->
          val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
          val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
              RecognizerIntent.EXTRA_LANGUAGE_MODEL,
              RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale.toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
          }
          var resolved = false
          fun resolve(value: String?) {
            if (resolved) return
            resolved = true
            runCatching { recognizer.destroy() }
            if (cont.isActive) cont.resume(value)
          }
          recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onResults(bundle: Bundle?) {
              val list = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
              resolve(list?.firstOrNull())
            }
            override fun onError(error: Int) = resolve(null)
            override fun onReadyForSpeech(p0: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(p0: Float) {}
            override fun onBufferReceived(p0: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(p0: Bundle?) {}
            override fun onEvent(p0: Int, p1: Bundle?) {}
          })
          recognizer.startListening(intent)
          cont.invokeOnCancellation { resolve(null) }
        }
      }
    }
  }
}
