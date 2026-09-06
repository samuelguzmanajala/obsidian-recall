package com.recall.voice.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import com.recall.voice.api.AudioSide
import com.recall.voice.api.RecallApi
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume

/**
 * Plays card audio fetched from the plugin's /api/v1/audio endpoint.
 * Returns true on successful playback to completion, false on any failure
 * (network, HTTP error, MediaPlayer error). The caller is expected to fall
 * back to on-device TTS when this returns false.
 */
class RemoteAudioPlayer(
  private val context: Context,
  private val api: RecallApi,
) {

  suspend fun play(studyItemId: String, side: AudioSide): Boolean {
    val tmp = tmpFile(studyItemId, side)
    // If pre-fetched, skip the network round-trip
    if (tmp.length() == 0L) {
      val downloaded = api.downloadAudio(studyItemId, side, tmp)
      if (!downloaded || tmp.length() == 0L) return false
    }
    return playFile(tmp)
  }

  /**
   * Download the audio in advance to local cache. Idempotent: re-running for
   * the same (studyItemId, side) is a no-op. Returns true on successful download.
   */
  suspend fun prefetch(studyItemId: String, side: AudioSide): Boolean {
    val tmp = tmpFile(studyItemId, side)
    if (tmp.length() > 0L) return true
    return api.downloadAudio(studyItemId, side, tmp)
  }

  private fun tmpFile(studyItemId: String, side: AudioSide): File =
    File(context.cacheDir, "recall-${studyItemId}-${side.pathSegment}.mp3")

  /**
   * Drop every mp3 this player has previously written to cacheDir. Call at the
   * start of a new session so the phone never replays stale audio after the
   * server regenerated cards under a different model / voice / instructions.
   */
  fun clearCache() {
    context.cacheDir.listFiles()?.forEach { f ->
      if (f.name.startsWith("recall-") && f.name.endsWith(".mp3")) {
        runCatching { f.delete() }
      }
    }
  }

  private suspend fun playFile(file: File): Boolean = suspendCancellableCoroutine { cont ->
    val player = MediaPlayer()
    try {
      player.setAudioAttributes(
        AudioAttributes.Builder()
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .setUsage(AudioAttributes.USAGE_ASSISTANT)
          .build()
      )
      player.setAudioStreamType(AudioManager.STREAM_MUSIC)
      player.setDataSource(file.absolutePath)
      player.setOnCompletionListener {
        runCatching { player.release() }
        if (cont.isActive) cont.resume(true)
      }
      player.setOnErrorListener { _, _, _ ->
        runCatching { player.release() }
        if (cont.isActive) cont.resume(false)
        true
      }
      player.prepare()
      player.start()
    } catch (e: Throwable) {
      runCatching { player.release() }
      if (cont.isActive) cont.resume(false)
    }
    cont.invokeOnCancellation {
      runCatching { player.stop() }
      runCatching { player.release() }
    }
  }
}
