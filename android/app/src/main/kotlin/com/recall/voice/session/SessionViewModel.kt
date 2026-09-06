package com.recall.voice.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.recall.voice.api.AudioSide
import com.recall.voice.api.DueItem
import com.recall.voice.api.Rating
import com.recall.voice.api.RecallApi
import com.recall.voice.api.ReviewSubmit
import com.recall.voice.voice.RemoteAudioPlayer
import com.recall.voice.voice.SttEngine
import com.recall.voice.voice.TtsEngine
import com.recall.voice.voice.parseRating
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Locale

private const val FETCH_BATCH = 20
private const val PREFETCH_AHEAD = 3

/** Hard ceiling on each listening phase (reveal + rating). */
private const val LISTEN_MAX_MS = 30_000L
/** Each underlying STT call has its own short timeout — short enough that
 *  if STT yields nothing (silence) we restart promptly, but not so short that
 *  we churn through SpeechRecognizer instances. */
private const val LISTEN_CHUNK_MS = 12_000L

/** Words that explicitly mean "show the answer / I'm ready / advance". */
private val REVEAL_KEYWORDS = setOf(
  "siguiente", "ya", "listo", "vale", "respuesta", "ok", "okay",
  "next", "answer", "ready", "go", "show",
)

class SessionViewModel(
  private val api: RecallApi,
  private val tts: TtsEngine,
  private val stt: SttEngine,
  private val locale: Locale,
  private val defaultRatingOnTimeout: Rating,
  private val remotePlayer: RemoteAudioPlayer? = null,
  private val deckId: String? = null,
) : ViewModel() {

  private val _state = MutableStateFlow<SessionState>(SessionState.Idle)
  val state: StateFlow<SessionState> = _state.asStateFlow()

  private var sessionJob: Job? = null
  /** Active throughout the entire card. Tap a rating button at any point to override. */
  private var manualRating: CompletableDeferred<Rating>? = null
  /** Active during Q-reading + reveal-listen. Tap "show answer" to skip ahead. */
  private var skipToAnswer: CompletableDeferred<Unit>? = null
  private val prefetched = mutableSetOf<String>()

  fun start() {
    if (sessionJob?.isActive == true) return
    sessionJob = viewModelScope.launch { runSession() }
  }

  fun stop() {
    sessionJob?.cancel()
    _state.value = SessionState.Idle
  }

  /**
   * Tap a rating button at ANY point during the card — cancels TTS / STT
   * in flight, submits the rating, advances to next card.
   */
  fun submitManual(rating: Rating) {
    manualRating?.complete(rating)
  }

  /**
   * Tap "show answer" during question-reading or reveal-listen — cancels
   * those and jumps straight to the answer-reading phase.
   */
  fun skipToAnswerNow() {
    skipToAnswer?.complete(Unit)
  }

  override fun onCleared() {
    sessionJob?.cancel()
    tts.shutdown()
    super.onCleared()
  }

  private suspend fun runSession() {
    try {
      val ttsReady = tts.awaitInit()
      if (!ttsReady) {
        _state.value = SessionState.Error("TTS engine not available")
        return
      }

      // Wipe any stale audio from previous sessions (model / voice / prompt
      // changes invalidate server-side cache; the phone's local files survive
      // unless we drop them explicitly).
      remotePlayer?.clearCache()
      prefetched.clear()

      _state.value = SessionState.Fetching
      val buffer = api.getDue(deckId = deckId, limit = FETCH_BATCH).toMutableList()
      if (buffer.isEmpty()) {
        _state.value = SessionState.Done(totalReviewed = 0)
        return
      }

      // Prefetch a window so card #2+ play instantly
      ensurePrefetchedAhead(buffer)

      var reviewed = 0
      while (buffer.isNotEmpty()) {
        val item = buffer.removeAt(0)
        val total = reviewed + 1 + buffer.size
        val index = reviewed + 1

        // Each iteration: keep the next PREFETCH_AHEAD items warm
        ensurePrefetchedAhead(buffer)

        val rating = playCardWithControls(item, index, total)

        _state.value = SessionState.Submitting(item, rating, index, total)
        val command = ReviewSubmit(item.studyItemId, rating, expectedRevision = item.revision)
        // Retry only transport failures, with the same operation ID and decision.
        // Never count/advance a card whose submission was rejected or unacknowledged.
        var acknowledged = false
        for (attempt in 0..2) {
          try {
            val result = api.postReviews(listOf(command))
            if (result.errors.isNotEmpty()) throw IllegalStateException(result.errors.first().reason)
            check(result.applied == 1) { "Backend did not acknowledge the review" }
            acknowledged = true
            break
          } catch (e: java.io.IOException) {
            if (attempt == 2) throw e
            kotlinx.coroutines.delay(1000L * (attempt + 1))
          }
        }
        check(acknowledged) { "Review not saved; reconnect before continuing" }
        reviewed++

        // Reconcile with the authority after every acknowledged review: remove
        // buried siblings and cards reviewed on another device, not just append.
        val fresh = api.getDue(deckId = deckId, limit = FETCH_BATCH)
        val byId = fresh.associateBy { it.studyItemId }
        val retained = buffer.mapNotNull { byId[it.studyItemId] }
        val retainedIds = retained.map { it.studyItemId }.toSet()
        buffer.clear()
        buffer.addAll(retained)
        buffer.addAll(fresh.filter { it.studyItemId !in retainedIds })
      }
      _state.value = SessionState.Done(totalReviewed = reviewed)
    } catch (e: kotlinx.coroutines.CancellationException) {
      throw e
    } catch (e: Exception) {
      _state.value = SessionState.Error(e.message ?: e::class.java.simpleName)
    }
  }

  /**
   * Play a single card from question through to a rating, with two
   * interrupt channels available throughout:
   *  - tap any rating button → submitManual() → returns that rating immediately
   *  - tap "show answer" during Q-reading or reveal-listen → jumps to answer-reading
   *
   * Cancellation of the in-flight TTS / STT happens automatically because
   * each phase runs inside a coroutine that we cancel on interrupt.
   */
  private suspend fun playCardWithControls(item: DueItem, index: Int, total: Int): Rating = coroutineScope {
    val ratingDeferred = CompletableDeferred<Rating>()
    val skipDeferred = CompletableDeferred<Unit>()
    manualRating = ratingDeferred
    skipToAnswer = skipDeferred
    try {
      // Phase 1: question + reveal-listen (skippable to answer or rating)
      val phase1 = launch {
        _state.value = SessionState.ReadingQuestion(item, index, total)
        speak(item, AudioSide.Question, item.voiceQuestion)
        _state.value = SessionState.ListeningReveal(item, index, total)
        listenForReveal()
      }
      kotlinx.coroutines.selects.select<Unit> {
        phase1.onJoin { /* natural completion */ }
        skipDeferred.onAwait { /* user wants answer now */ }
        ratingDeferred.onAwait { /* user submitted rating */ }
      }
      phase1.cancel()
      if (ratingDeferred.isCompleted) return@coroutineScope ratingDeferred.await()

      // Phase 2: answer-reading + rating-listen (skippable to rating only)
      val phase2 = launch {
        _state.value = SessionState.ReadingAnswer(item, index, total)
        speak(item, AudioSide.Answer, item.voiceAnswer)
        _state.value = SessionState.ListeningRating(item, index, total)
        val r = listenForRatingViaStt() ?: defaultRatingOnTimeout
        if (!ratingDeferred.isCompleted) ratingDeferred.complete(r)
      }
      val r = ratingDeferred.await()
      phase2.cancel()
      r
    } finally {
      manualRating = null
      skipToAnswer = null
    }
  }

  /**
   * Pure STT-driven rating loop. Returns the recognized Rating, or null on
   * timeout. Caller decides what to do with null (default fallback).
   */
  private suspend fun listenForRatingViaStt(): Rating? {
    stt.playReadyTone()
    kotlinx.coroutines.delay(180)
    val deadline = System.currentTimeMillis() + LISTEN_MAX_MS
    while (true) {
      val remaining = deadline - System.currentTimeMillis()
      if (remaining < 500) return null
      val chunk = remaining.coerceAtMost(LISTEN_CHUNK_MS)
      val raw = stt.listenOnce(locale, chunk)
      val r = parseRating(raw)
      if (r != null) return r
      // unrecognized — keep listening
    }
  }

  /**
   * Wait until the user explicitly says one of [REVEAL_KEYWORDS] (or the
   * hard timeout fires). Lets the user think for as long as they need on
   * tough cards, advance instantly on easy ones. The "ready tone" plays
   * once at the start so they know when the mic opens.
   */
  private suspend fun listenForReveal() {
    stt.playReadyTone()
    kotlinx.coroutines.delay(180)
    val deadline = System.currentTimeMillis() + LISTEN_MAX_MS
    while (true) {
      val remaining = deadline - System.currentTimeMillis()
      if (remaining < 500) return
      val chunk = remaining.coerceAtMost(LISTEN_CHUNK_MS)
      val raw = stt.listenOnce(locale, chunk) ?: continue
      if (matchesRevealKeyword(raw)) return
      // Unrecognized speech (mumbling, attempting recall) — keep listening.
    }
  }

  private fun matchesRevealKeyword(text: String): Boolean {
    val tokens = text.lowercase()
      .replace(Regex("[áàâ]"), "a").replace(Regex("[éèê]"), "e")
      .replace(Regex("[íì]"), "i").replace(Regex("[óòô]"), "o")
      .replace(Regex("[úù]"), "u")
      .split(Regex("[\\s,.!?¡¿]+"))
      .filter { it.isNotBlank() }
    return tokens.any { it in REVEAL_KEYWORDS }
  }

  /**
   * Fire-and-forget prefetch of the next [PREFETCH_AHEAD] items' Q + A audio
   * so playback in subsequent iterations is instant from the local cache.
   * Deduplicated via [prefetched] — calling this every loop iteration is cheap.
   */
  private fun ensurePrefetchedAhead(buffer: List<DueItem>) {
    val rp = remotePlayer ?: return
    val targets = buffer.take(PREFETCH_AHEAD)
    for (next in targets) {
      for (side in listOf(AudioSide.Question, AudioSide.Answer)) {
        val key = "${next.studyItemId}-${side.pathSegment}"
        if (prefetched.add(key)) {
          viewModelScope.launch { runCatching { rp.prefetch(next.studyItemId, side) } }
        }
      }
    }
  }

  /**
   * Speak a card side. Tries the remote audio endpoint first (cloud TTS,
   * properly multilingual). Falls back to on-device TtsEngine on any failure
   * so a sessions never gets stuck if the server is unreachable.
   */
  private suspend fun speak(item: DueItem, side: AudioSide, fallbackText: String) {
    if (remotePlayer != null) {
      val ok = remotePlayer.play(item.studyItemId, side)
      if (ok) return
    }
    tts.speak(fallbackText, locale)
  }

  /** Snapshot of current item, exposed for UI fallback rendering. */
  fun currentItem(): DueItem? = state.value.currentItem
}
