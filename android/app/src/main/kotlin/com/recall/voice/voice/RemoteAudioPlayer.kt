package com.recall.voice.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import com.recall.voice.api.AudioSide
import com.recall.voice.api.RecallApi
import com.recall.voice.session.Timing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume

/** Prefetch downloads allowed at once; on-demand downloads for the card on screen do not wait for these. */
private const val PREFETCH_PARALLEL = 2

/**
 * Plays card audio fetched from the server's /api/v1/audio endpoint, cached on disk by content
 * (see [AudioCache]). Downloads are shared per file: a play that needs a file already being
 * prefetched waits for that download instead of starting a second one.
 */
class RemoteAudioPlayer(
  context: Context,
  private val api: RecallApi,
  /** Playback speed, 1.0 = normal. */
  private val speed: Float = 1f,
  private val cache: AudioCache = AudioCache(context.cacheDir),
) {
  private val main = Handler(Looper.getMainLooper())
  private val prefetchPermits = Semaphore(PREFETCH_PARALLEL)
  private val locksGuard = Mutex()
  private val keyLocks = HashMap<String, Mutex>()

  /** Drops expired audio and keeps the cache under its size limit. Never wipes fresh audio. */
  suspend fun evictCache() = withContext(Dispatchers.IO) { runCatching { cache.evict() } }

  fun isCached(studyItemId: String, side: AudioSide, text: String): Boolean =
    cache.fileFor(studyItemId, side.pathSegment, text).length() > 0L

  /**
   * Makes sure the file exists, downloading it or joining a download already running for it.
   * Returns true when it is ready. Never throws except for cancellation.
   */
  suspend fun download(studyItemId: String, side: AudioSide, text: String, why: String): Boolean {
    val target = cache.fileFor(studyItemId, side.pathSegment, text)
    val lock = locksGuard.withLock { keyLocks.getOrPut(target.name) { Mutex() } }
    return lock.withLock {
      if (target.length() > 0L) return@withLock true
      val startedAt = Timing.now()
      val temp = cache.tempFor(target)
      val ok = try {
        api.downloadAudio(studyItemId, side, temp) && withContext(Dispatchers.IO) { cache.commit(temp, target) }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        false
      } finally {
        if (temp.exists()) withContext(Dispatchers.IO + kotlinx.coroutines.NonCancellable) { temp.delete() }
      }
      Timing.log("audio-download", startedAt, "${side.pathSegment} $why ok=$ok")
      ok
    }
  }

  /** Background download, at most [PREFETCH_PARALLEL] at a time, in the order requested. */
  suspend fun prefetch(studyItemId: String, side: AudioSide, text: String): Boolean =
    prefetchPermits.withPermit { download(studyItemId, side, text, "prefetch") }

  /**
   * Plays the cached file to completion. Returns false when it is not cached or cannot be played;
   * the caller then falls back to the device voice.
   */
  suspend fun playCached(studyItemId: String, side: AudioSide, text: String): Boolean {
    val file = cache.fileFor(studyItemId, side.pathSegment, text)
    if (file.length() == 0L) return false
    file.setLastModified(System.currentTimeMillis())
    return playFile(file)
  }

  /** Prepares asynchronously (never blocking the main thread) and plays; cancellable at any point. */
  private suspend fun playFile(file: File): Boolean = withContext(Dispatchers.Main) {
    suspendCancellableCoroutine { cont ->
      val player = MediaPlayer()
      var released = false
      fun release() {
        if (released) return
        released = true
        runCatching { player.release() }
      }
      fun finish(ok: Boolean) {
        release()
        if (cont.isActive) cont.resume(ok)
      }
      val preparingAt = Timing.now()
      try {
        player.setAudioAttributes(
          AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .setUsage(AudioAttributes.USAGE_ASSISTANT)
            .build()
        )
        @Suppress("DEPRECATION")
        player.setAudioStreamType(AudioManager.STREAM_MUSIC)
        player.setDataSource(file.absolutePath)
        player.setOnPreparedListener { mp ->
          Timing.log("audio-prepare", preparingAt)
          if (released || !cont.isActive) { release(); return@setOnPreparedListener }
          try {
            if (speed != 1f) runCatching { mp.playbackParams = mp.playbackParams.setSpeed(speed) }
            mp.start()
          } catch (e: Exception) {
            finish(false)
          }
        }
        player.setOnCompletionListener { finish(true) }
        player.setOnErrorListener { _, _, _ -> finish(false); true }
        player.prepareAsync()
      } catch (e: Exception) {
        finish(false)
      }
      cont.invokeOnCancellation {
        main.post {
          if (!released) runCatching { player.stop() }
          release()
        }
      }
    }
  }
}
