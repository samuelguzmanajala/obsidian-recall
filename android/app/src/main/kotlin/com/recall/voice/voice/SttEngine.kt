package com.recall.voice.voice

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.recall.voice.session.Timing
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import kotlin.coroutines.resume

/** Errors after which the recogniser instance is no longer trustworthy and is rebuilt. */
private val RECREATE_ON = setOf(
  SpeechRecognizer.ERROR_CLIENT,
  SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
  11, // SpeechRecognizer.ERROR_SERVER_DISCONNECTED (API 31)
)

/**
 * Speech recognition for a session. One [SpeechRecognizer] is created lazily and reused for every
 * listen; it lives on the main thread and is destroyed by [close].
 */
class SttEngine(private val context: Context) {

  private val main = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var tone: ToneGenerator? = null

  /**
   * Play a short "your turn" tone. Routed through STREAM_MUSIC so it reaches
   * the Bluetooth speaker the same way the TTS audio does.
   */
  fun playReadyTone() {
    if (tone == null) tone = runCatching { ToneGenerator(AudioManager.STREAM_MUSIC, 80) }.getOrNull()
    runCatching { tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 120) }
  }

  /**
   * Listen for at most [timeoutMs]. Every partial and the final result are offered to [accept]
   * with all alternatives; the first non-null value it returns ends the listen at once (the
   * recogniser is cancelled) and is returned. With [settleMs], the latest partial is offered
   * again after that long without news, so a time-based rule can fire without waiting for the
   * end of speech. Returns null on timeout, error, silence or a final result [accept] refuses.
   */
  suspend fun <T : Any> listenFor(
    locale: Locale,
    timeoutMs: Long,
    settleMs: Long? = null,
    accept: (hypotheses: List<String>, isFinal: Boolean) -> T?,
  ): T? = withContext(Dispatchers.Main) {
    withTimeoutOrNull(timeoutMs) {
      suspendCancellableCoroutine { cont -> Listen(cont, locale, settleMs, accept).start() }
    }
  }

  private inner class Listen<T : Any>(
    private val cont: CancellableContinuation<T?>,
    private val locale: Locale,
    private val settleMs: Long?,
    private val accept: (List<String>, Boolean) -> T?,
  ) : RecognitionListener {
    private val startedAt = Timing.now()
    private var done = false
    private var lastPartial: List<String>? = null
    private val recheck = Runnable { lastPartial?.let { offer(it, isFinal = false, how = "partial-settled") } }
    private lateinit var rec: SpeechRecognizer

    fun start() {
      rec = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also {
        recognizer = it
        Timing.mark("stt-create")
      }
      rec.setRecognitionListener(this)
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale.toLanguageTag())
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      }
      cont.invokeOnCancellation { main.post { stop(cancelRecognizer = true) } }
      runCatching { rec.startListening(intent) }.onFailure { recreate("start ${it::class.java.simpleName}"); finish(null) }
    }

    private fun stop(cancelRecognizer: Boolean) {
      if (done) return
      done = true
      main.removeCallbacks(recheck)
      if (cancelRecognizer) runCatching { rec.cancel() }
    }

    private fun finish(value: T?) {
      if (done) return
      stop(cancelRecognizer = value != null)
      if (cont.isActive) cont.resume(value)
    }

    private fun offer(hypotheses: List<String>, isFinal: Boolean, how: String) {
      if (done) return
      val value = accept(hypotheses, isFinal)
      if (value != null) {
        Timing.log("stt-accept", startedAt, "$how heard=${hypotheses.firstOrNull() ?: "-"}")
        finish(value)
      } else if (isFinal) {
        Timing.log("stt-final", startedAt, "not accepted heard=${hypotheses.firstOrNull() ?: "-"}")
        finish(null)
      }
    }

    private fun hypotheses(bundle: Bundle?): List<String> =
      bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty().filter { it.isNotBlank() }

    override fun onPartialResults(bundle: Bundle?) {
      val list = hypotheses(bundle)
      if (list.isEmpty() || done) return
      lastPartial = list
      main.removeCallbacks(recheck)
      offer(list, isFinal = false, how = "partial")
      if (!done && settleMs != null) main.postDelayed(recheck, settleMs)
    }

    override fun onResults(bundle: Bundle?) = offer(hypotheses(bundle), isFinal = true, how = "final")

    override fun onError(error: Int) {
      if (done) return
      if (error in RECREATE_ON) recreate("error $error")
      Timing.log("stt-error", startedAt, "code=$error")
      finish(null)
    }

    override fun onReadyForSpeech(p0: Bundle?) = Timing.log("stt-ready", startedAt, "mic open")
    override fun onBeginningOfSpeech() {}
    override fun onRmsChanged(p0: Float) {}
    override fun onBufferReceived(p0: ByteArray?) {}
    override fun onEndOfSpeech() {}
    override fun onEvent(p0: Int, p1: Bundle?) {}
  }

  /** Main thread only. */
  private fun recreate(reason: String) {
    val old = recognizer ?: return
    recognizer = null
    runCatching { old.destroy() }
    Timing.mark("stt-recreate $reason")
  }

  /** Release the recogniser and the tone. Safe to call more than once, from any thread. */
  fun close() {
    val release = Runnable {
      recognizer?.let { runCatching { it.destroy() } }
      recognizer = null
      tone?.let { runCatching { it.release() } }
      tone = null
    }
    if (Looper.myLooper() == Looper.getMainLooper()) release.run() else main.post(release)
  }
}
