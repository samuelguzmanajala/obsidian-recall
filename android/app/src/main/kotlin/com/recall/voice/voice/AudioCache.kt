package com.recall.voice.voice

import java.io.File
import java.security.MessageDigest
import java.util.UUID

private const val DAY_MS = 24L * 60 * 60 * 1000
const val AUDIO_MAX_AGE_MS = 7 * DAY_MS
const val AUDIO_MAX_BYTES = 100L * 1024 * 1024
/** A half-download older than this belongs to a session that is gone. */
private const val PART_MAX_AGE_MS = 60L * 60 * 1000
private const val PART_SUFFIX = ".part"

/** Cache key for one side of a card: an edited card gets a new key, so new audio. */
fun audioKey(studyItemId: String, side: String, text: String): String =
  MessageDigest.getInstance("SHA-256")
    .digest("$studyItemId\u0000$side\u0000$text".toByteArray())
    .joinToString("") { "%02x".format(it) }

data class CachedFile(val name: String, val bytes: Long, val modifiedAt: Long)

/**
 * Names of the files to delete: anything older than [maxAgeMs], stale half-downloads, and then
 * the least recently used files until the rest fit in [maxBytes]. Young half-downloads are
 * in flight and left alone.
 */
fun planEviction(files: List<CachedFile>, now: Long, maxAgeMs: Long, maxBytes: Long): Set<String> {
  val evict = HashSet<String>()
  val kept = ArrayList<CachedFile>()
  for (f in files) {
    val part = f.name.endsWith(PART_SUFFIX)
    when {
      part && now - f.modifiedAt > PART_MAX_AGE_MS -> evict += f.name
      part -> Unit
      now - f.modifiedAt > maxAgeMs -> evict += f.name
      else -> kept += f
    }
  }
  var total = 0L
  for (f in kept.sortedByDescending { it.modifiedAt }) {
    total += f.bytes
    if (total > maxBytes) evict += f.name
  }
  return evict
}

/** Downloaded card audio under `cacheDir/recall-audio`, keyed by content. */
class AudioCache(cacheRoot: File) {
  private val legacyRoot = cacheRoot
  val dir = File(cacheRoot, "recall-audio")

  fun fileFor(studyItemId: String, side: String, text: String): File = File(dir, "${audioKey(studyItemId, side, text)}.mp3")

  /** A unique temporary file next to [target]; commit it with [commit]. */
  fun tempFor(target: File): File {
    dir.mkdirs()
    return File(dir, "${target.name}.${UUID.randomUUID()}$PART_SUFFIX")
  }

  /** Atomically publishes a finished download. A half-download is never visible under [target]. */
  fun commit(temp: File, target: File): Boolean {
    if (temp.length() == 0L) { temp.delete(); return false }
    if (temp.renameTo(target)) return true
    temp.delete()
    return target.length() > 0L
  }

  /** Blocking. Applies [planEviction] and removes audio left by earlier versions of the app. */
  fun evict(now: Long = System.currentTimeMillis()) {
    deleteLegacy()
    val files = dir.listFiles()?.filter { it.isFile }.orEmpty()
    val doomed = planEviction(files.map { CachedFile(it.name, it.length(), it.lastModified()) }, now, AUDIO_MAX_AGE_MS, AUDIO_MAX_BYTES)
    files.filter { it.name in doomed }.forEach { runCatching { it.delete() } }
  }

  /** Blocking. Deletes every downloaded audio file. Returns how many were deleted. */
  fun clear(): Int {
    deleteLegacy()
    return dir.listFiles()?.count { it.isFile && runCatching { it.delete() }.getOrDefault(false) } ?: 0
  }

  private fun deleteLegacy() {
    legacyRoot.listFiles()?.forEach { f ->
      if (f.isFile && f.name.startsWith("recall-") && f.name.endsWith(".mp3")) runCatching { f.delete() }
    }
  }
}
