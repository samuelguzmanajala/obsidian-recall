package com.recall.voice.voice

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class AudioCacheTest {
  @TempDir lateinit var root: File
  private val day = 24L * 60 * 60 * 1000
  private val now = 100 * day

  @Test fun `the key changes with the card, the side and the spoken text`() {
    val base = audioKey("s1", "question", "hola")
    assertEquals(base, audioKey("s1", "question", "hola"))
    assertNotEquals(base, audioKey("s2", "question", "hola"))
    assertNotEquals(base, audioKey("s1", "answer", "hola"))
    assertNotEquals(base, audioKey("s1", "question", "hola!"))
    // No ambiguity from concatenation.
    assertNotEquals(audioKey("s1", "question", "x"), audioKey("s1q", "uestion", "x"))
  }

  @Test fun `evicts files older than seven days`() {
    val files = listOf(CachedFile("old.mp3", 10, now - 8 * day), CachedFile("new.mp3", 10, now - day))
    assertEquals(setOf("old.mp3"), planEviction(files, now, AUDIO_MAX_AGE_MS, AUDIO_MAX_BYTES))
  }

  @Test fun `keeps the most recent files under the size limit`() {
    val files = listOf(
      CachedFile("a.mp3", 40, now - 3),
      CachedFile("b.mp3", 40, now - 1),
      CachedFile("c.mp3", 40, now - 2),
    )
    assertEquals(setOf("a.mp3"), planEviction(files, now, AUDIO_MAX_AGE_MS, maxBytes = 100))
  }

  @Test fun `half downloads are left alone while young and removed when stale`() {
    val files = listOf(CachedFile("x.mp3.1.part", 5, now - 1000), CachedFile("y.mp3.2.part", 5, now - 2 * 60 * 60 * 1000))
    assertEquals(setOf("y.mp3.2.part"), planEviction(files, now, AUDIO_MAX_AGE_MS, AUDIO_MAX_BYTES))
  }

  @Test fun `commit publishes atomically and refuses empty downloads`() {
    val cache = AudioCache(root)
    val target = cache.fileFor("s1", "question", "hola")
    val empty = cache.tempFor(target).apply { writeBytes(ByteArray(0)) }
    assertFalse(cache.commit(empty, target))
    assertFalse(target.exists())
    val full = cache.tempFor(target).apply { writeBytes(byteArrayOf(1, 2, 3)) }
    assertTrue(cache.commit(full, target))
    assertEquals(3, target.length())
    assertFalse(full.exists())
  }

  @Test fun `clear deletes downloaded audio, including the old flat layout`() {
    val cache = AudioCache(root)
    val target = cache.fileFor("s1", "question", "hola")
    cache.commit(cache.tempFor(target).apply { writeBytes(byteArrayOf(1)) }, target)
    val legacy = File(root, "recall-s1-question.mp3").apply { writeBytes(byteArrayOf(1)) }
    val unrelated = File(root, "other.txt").apply { writeText("keep") }
    assertEquals(1, cache.clear())
    assertFalse(target.exists()); assertFalse(legacy.exists()); assertTrue(unrelated.exists())
  }

  @Test fun `evict keeps fresh audio`() {
    val cache = AudioCache(root)
    val target = cache.fileFor("s1", "question", "hola")
    cache.commit(cache.tempFor(target).apply { writeBytes(byteArrayOf(1)) }, target)
    cache.evict()
    assertTrue(target.exists())
  }
}
