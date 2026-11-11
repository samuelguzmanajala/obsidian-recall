package com.recall.voice.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.recall.voice.api.AudioSide
import com.recall.voice.api.DueItem
import com.recall.voice.api.DueRequest
import com.recall.voice.api.Rating
import com.recall.voice.api.RecallApi
import com.recall.voice.api.ReviewSubmit
import com.recall.voice.voice.RatingStabilizer
import com.recall.voice.voice.RATING_STABLE_MS
import com.recall.voice.voice.RemoteAudioPlayer
import com.recall.voice.voice.SttEngine
import com.recall.voice.voice.TtsEngine
import com.recall.voice.voice.matchesRevealKeyword
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale

/** Large enough to hold the whole due queue, so the progress total is real and stable. */
private const val FETCH_BATCH = 200
/** Cards whose audio is downloaded ahead of time. */
private const val PREFETCH_AHEAD = 5

/** Hard ceiling on each listening phase (reveal + rating). */
private const val LISTEN_MAX_MS = 30_000L
/** Each underlying STT call has its own timeout, so silence restarts the recogniser promptly. */
private const val LISTEN_CHUNK_MS = 12_000L
/** Pause after the ready tone so the beep is not heard by the recogniser. */
private const val TONE_GUARD_MS = 180L
/** How long a side waits for the server voice before the device voice reads it instead. */
const val AUDIO_READY_TIMEOUT_MS = 3_000L

/** The sender keeps failing; the session stops at the card boundary. */
private class ReviewsNotSavedException(message: String) : Exception(message)

/** A card passed in this session and what became of its review. */
private class Passed(val command: ReviewSubmit, val conceptId: String, var status: StationStatus)

class SessionViewModel(
  private val api: RecallApi,
  private val tts: TtsEngine,
  private val stt: SttEngine,
  private val locale: Locale,
  private val outbox: ReviewOutbox,
  private val remotePlayer: RemoteAudioPlayer? = null,
  private val deckId: String? = null,
) : ViewModel() {

  private val _state = MutableStateFlow<SessionState>(SessionState.Idle)
  val state: StateFlow<SessionState> = _state.asStateFlow()

  /** One station per card passed in this session, with its review's status. */
  private val _stations = MutableStateFlow<List<Station>>(emptyList())
  val stations: StateFlow<List<Station>> = _stations.asStateFlow()

  // Session data. Touched only from the main thread (viewModelScope), so no locking.
  private val passed = mutableListOf<Passed>()
  private val buffer = mutableListOf<DueItem>()
  private var current: DueItem? = null
  private var background: CoroutineScope? = null
  private var refreshRequests = Channel<Unit>(Channel.CONFLATED)
  /** The first `GET /due` of the session has filled [buffer]; queues from reviews apply only after it. */
  private var queueLoaded = false
  private val prefetched = mutableSetOf<String>()

  private var sessionJob: Job? = null
  /** Active throughout the entire card. Tap a rating button at any point to override. */
  private var manualRating: CompletableDeferred<Rating>? = null
  /** Active during Q-reading + reveal-listen. Tap "show answer" to skip ahead. */
  private var skipToAnswer: CompletableDeferred<Unit>? = null
  private var resumeListening: CompletableDeferred<Unit>? = null
  fun resumeVoice() { resumeListening?.complete(Unit) }

  fun start() {
    if (sessionJob?.isActive == true) return
    sessionJob = viewModelScope.launch { runSession() }
  }

  fun stop() {
    sessionJob?.cancel()
    _state.value = SessionState.Idle
  }

  /** Tap a rating button at ANY point during the card: cancels TTS / STT in flight and decides. */
  fun submitManual(rating: Rating) {
    manualRating?.complete(rating)
  }

  /** Tap "show answer" during question-reading or reveal-listen. */
  fun skipToAnswerNow() {
    skipToAnswer?.complete(Unit)
  }

  /**
   * Stop the session and release the speech engines. Every decided review is already in the
   * journal (it is written before the card advances), so nothing pending is lost here: the home
   * screen or the next session sends it.
   */
  fun close() {
    sessionJob?.cancel()
    tts.shutdown()
    stt.close()
  }

  override fun onCleared() {
    close()
    super.onCleared()
  }

  private suspend fun runSession() {
    try {
      coroutineScope {
        background = this
        try { session() } finally { coroutineContext.cancelChildren() }
      }
    } catch (e: kotlinx.coroutines.CancellationException) {
      throw e
    } catch (e: ReviewsNotSavedException) {
      _state.value = SessionState.Error(e.message.orEmpty(), ErrorKind.ReviewsNotSaved)
    } catch (e: Exception) {
      _state.value = SessionState.Error(e.message ?: e::class.java.simpleName)
    } finally {
      background = null
    }
  }

  private suspend fun CoroutineScope.session() {
    if (!tts.awaitInit()) {
      _state.value = SessionState.Error("TTS engine not available", ErrorKind.VoiceUnavailable)
      return
    }
    _state.value = SessionState.Fetching
    remotePlayer?.evictCache()
    prefetched.clear(); passed.clear(); buffer.clear(); current = null
    publishStations()
    refreshRequests = Channel(Channel.CONFLATED)

    queueLoaded = false
    // Built once, valid by construction (limit is a constant in range, a null/blank deck is left
    // out): an invalid `due` would make every send a 400 and stall the journal.
    val dueRequest = DueRequest.of(deckId, FETCH_BATCH)
    val sender = ReviewSender(outbox, { reviews -> api.postReviews(reviews, dueRequest) }, ::onReviewOutcome)
    sender.loadPending()
    launch { sender.run() }
    // Reviews left by an earlier session go first, so the queue below already reflects them.
    passGate(sender, ::drainGate)

    buffer.addAll(api.getDue(deckId = deckId, limit = FETCH_BATCH))
    queueLoaded = true
    launch { refreshLoop() }

    var lastDecidedAt: Long? = null
    while (true) {
      if (buffer.isEmpty()) {
        // Done only once every review is confirmed or rejected, and the server has nothing more.
        passGate(sender, ::drainGate)
        val fresh = api.getDue(deckId = deckId, limit = FETCH_BATCH)
        // The queue ran out: take the next batch even if the server cut it.
        applyFresh(fresh, appendNew = true)
        if (buffer.isEmpty()) break
      }
      passGate(sender, ::cardGate)

      val item = buffer.removeAt(0)
      current = item
      val index = passed.size + 1
      val total = index + buffer.size
      ensurePrefetchedAhead()
      Timing.mark("card $index/$total start")
      lastDecidedAt?.let { Timing.log("between-cards", it, "rating decided to next card") }

      val rating = playCardWithControls(item, index, total)
      val decidedAt = Timing.now()
      lastDecidedAt = decidedAt
      _state.value = SessionState.Submitting(item, rating, index, total)

      // Durable before anything else: the journal is the only copy that matters.
      val command = ReviewSubmit(item.studyItemId, rating, expectedRevision = item.revision)
      sender.enqueue(command)
      Timing.log("enqueue", decidedAt, "pending=${sender.status.value.pending}")
      passed += Passed(command, item.conceptId, StationStatus.Pending)
      publishStations()
      val remaining = dropSiblings(buffer, item)
      buffer.clear(); buffer.addAll(remaining)
      current = null
    }
    _state.value = SessionState.Done(totalReviewed = passed.count { it.status == StationStatus.Confirmed })
  }

  /** Suspends while [gate] says Wait (the state keeps showing "Saving…"); throws on Stop. */
  private suspend fun passGate(sender: ReviewSender, gate: (Int, Int) -> CardGate) {
    val waitedAt = Timing.now()
    val decision = sender.status.map { gate(it.pending, it.consecutiveFailures) }.first { it != CardGate.Wait }
    val waited = Timing.now() - waitedAt
    if (waited > 0) Timing.log("gate-wait", waitedAt, "$decision pending=${sender.status.value.pending}")
    if (decision == CardGate.Stop) throw ReviewsNotSavedException(sender.status.value.lastFailure.orEmpty())
  }

  private fun onReviewOutcome(outcome: SendOutcome) {
    val entry = passed.firstOrNull { it.command.operationId == outcome.command.operationId }
    if (entry == null) {
      Timing.mark("review from an earlier session ${if (outcome is SendOutcome.Confirmed) "confirmed" else "rejected"}")
    } else {
      entry.status = if (outcome is SendOutcome.Confirmed) StationStatus.Confirmed else StationStatus.Rejected
      publishStations()
    }
    val due = outcome.due
    when {
      // Older server: fetch the queue in the background, as before.
      due == null -> refreshRequests.trySend(Unit)
      // Reviews left by an earlier session, sent before the first load: that load follows the
      // drain and already reflects them, so this queue is not needed.
      !queueLoaded -> Timing.mark("queue-from-review ignored before first load fresh=${due.size}")
      else -> {
        applyFresh(due)
        Timing.mark("queue-from-review fresh=${due.size} queue=${buffer.size}")
      }
    }
  }

  private fun publishStations() {
    _stations.value = passed.map { Station(it.command.rating, it.status) }
  }

  /**
   * Background `GET /due` after a review whose response carried no queue (older server);
   * requests that pile up collapse into one.
   */
  private suspend fun refreshLoop() {
    for (request in refreshRequests) {
      val startedAt = Timing.now()
      val fresh = try {
        api.getDue(deckId = deckId, limit = FETCH_BATCH)
      } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
      } catch (e: Exception) {
        Timing.log("refresh", startedAt, "failed ${e::class.java.simpleName}")
        continue
      }
      applyFresh(fresh)
      Timing.log("refresh", startedAt, "queue=${buffer.size}")
    }
  }

  private fun applyFresh(fresh: List<DueItem>, appendNew: Boolean = fresh.size < FETCH_BATCH) {
    val reviewed = passed.map { ReviewedCard(it.command.studyItemId, it.conceptId, it.command.expectedRevision) }
    val next = reconcileQueue(buffer, fresh, current, reviewed, freshComplete = fresh.size < FETCH_BATCH, appendNew = appendNew)
    buffer.clear(); buffer.addAll(next)
    ensurePrefetchedAhead()
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
        speak(item, AudioSide.Question, item.voiceQuestion) { preparing ->
          _state.value = SessionState.ReadingQuestion(item, index, total, preparingAudio = preparing)
        }
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
        speak(item, AudioSide.Answer, item.voiceAnswer) { preparing ->
          _state.value = SessionState.ReadingAnswer(item, index, total, preparingAudio = preparing)
        }
        _state.value = SessionState.ListeningRating(item, index, total)
        val result = awaitVoiceDecision(
          listen = {
            _state.value = SessionState.ListeningRating(item, index, total)
            listenForRatingViaStt()
          },
          awaitResume = {
            val resume = CompletableDeferred<Unit>()
            resumeListening = resume
            _state.value = SessionState.AwaitingConfirmation(item, index, total)
            resume.await()
          },
        )
        if (!ratingDeferred.isCompleted) ratingDeferred.complete(result)
      }
      val r = ratingDeferred.await()
      phase2.cancel()
      r
    } finally {
      manualRating = null
      skipToAnswer = null
      resumeListening = null
    }
  }

  /**
   * STT-driven rating loop. Returns the recognised Rating, or null when nothing was recognised
   * before the hard timeout; the caller then pauses (it never becomes a rating).
   */
  private suspend fun listenForRatingViaStt(): Rating? {
    stt.playReadyTone()
    delay(TONE_GUARD_MS)
    val deadline = Timing.now() + LISTEN_MAX_MS
    while (true) {
      val remaining = deadline - Timing.now()
      if (remaining < 500) return null
      val heardAt = Timing.now()
      val stabilizer = RatingStabilizer(clock = Timing::now)
      var heard: String? = null
      val rating = stt.listenFor(locale, remaining.coerceAtMost(LISTEN_CHUNK_MS), settleMs = RATING_STABLE_MS + 20) { hypotheses, isFinal ->
        heard = hypotheses.firstOrNull() ?: heard
        stabilizer.offer(hypotheses, isFinal)
      }
      Timing.log("listen-rating", heardAt, "heard=${heard ?: "-"}")
      if (rating != null) return rating
      avoidBusyLoop(heardAt)
    }
  }

  /**
   * Wait until the user says one of the reveal keywords (or the hard timeout fires). The first
   * partial that contains one is enough. The ready tone plays once so they know the mic is open.
   */
  private suspend fun listenForReveal() {
    stt.playReadyTone()
    delay(TONE_GUARD_MS)
    val deadline = Timing.now() + LISTEN_MAX_MS
    while (true) {
      val remaining = deadline - Timing.now()
      if (remaining < 500) return
      val heardAt = Timing.now()
      var heard: String? = null
      val revealed = stt.listenFor(locale, remaining.coerceAtMost(LISTEN_CHUNK_MS)) { hypotheses, _ ->
        heard = hypotheses.firstOrNull() ?: heard
        if (hypotheses.any(::matchesRevealKeyword)) Unit else null
      }
      Timing.log("listen-reveal", heardAt, "heard=${heard ?: "-"}")
      if (revealed != null) return
      avoidBusyLoop(heardAt)
    }
  }

  /** A recogniser that fails instantly must not spin the loop. */
  private suspend fun avoidBusyLoop(startedAt: Long) {
    if (Timing.now() - startedAt < 300) delay(250)
  }

  /**
   * Download ahead: the current card's answer first, then the next [PREFETCH_AHEAD] cards'
   * question and answer in queue order. The player runs at most two at a time, in this order.
   * Deduplicated, so calling it often is cheap.
   */
  private fun ensurePrefetchedAhead() {
    val rp = remotePlayer ?: return
    val scope = background ?: return
    val targets = buildList {
      current?.let { add(Triple(it, AudioSide.Answer, it.voiceAnswer)) }
      for (next in buffer.take(PREFETCH_AHEAD)) {
        add(Triple(next, AudioSide.Question, next.voiceQuestion))
        add(Triple(next, AudioSide.Answer, next.voiceAnswer))
      }
    }
    for ((item, side, text) in targets) {
      if (prefetched.add("${item.studyItemId}|${side.pathSegment}|$text")) {
        scope.launch { rp.prefetch(item.studyItemId, side, text) }
      }
    }
  }

  /**
   * Speak a card side with the server voice when it is ready, else the device voice.
   * If the audio is still downloading, [onState] reports `preparing = true`; after
   * [AUDIO_READY_TIMEOUT_MS] the device voice takes over and the download continues in the
   * background for next time (it is not played afterwards for this side).
   * Returns only when the side has been spoken, so listening never starts before.
   */
  private suspend fun speak(item: DueItem, side: AudioSide, text: String, onState: (preparing: Boolean) -> Unit) {
    val startedAt = Timing.now()
    val rp = remotePlayer
    if (rp != null) {
      var ready = rp.isCached(item.studyItemId, side, text)
      if (!ready) {
        onState(true)
        val scope = background
        val download = scope?.async { rp.download(item.studyItemId, side, text, "on-demand") }
        ready = withTimeoutOrNull(AUDIO_READY_TIMEOUT_MS) { download?.await() } ?: false
        Timing.log("audio-wait", startedAt, "${side.pathSegment} ready=$ready${if (ready) "" else " device voice takes over"}")
      }
      onState(false)
      if (ready) {
        val playAt = Timing.now()
        val ok = rp.playCached(item.studyItemId, side, text)
        Timing.log("speak-${side.pathSegment}", playAt, "remote ok=$ok")
        if (ok) return
      }
    } else {
      onState(false)
    }
    val localAt = Timing.now()
    tts.speak(text, locale)
    Timing.log("speak-${side.pathSegment}", localAt, "device")
  }

  /** Snapshot of current item, exposed for UI fallback rendering. */
  fun currentItem(): DueItem? = state.value.currentItem
}
