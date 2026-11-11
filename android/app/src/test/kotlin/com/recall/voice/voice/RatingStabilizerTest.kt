package com.recall.voice.voice

import com.recall.voice.api.Rating
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class RatingStabilizerTest {
  private var now = 0L
  private val stabilizer = RatingStabilizer(clock = { now })

  @Test fun `a stable partial is accepted once the window has passed`() {
    assertNull(stabilizer.offer(listOf("tres"), isFinal = false))
    now = 299
    assertNull(stabilizer.offer(listOf("tres"), isFinal = false))
    now = 300
    assertEquals(Rating.Good, stabilizer.offer(listOf("tres"), isFinal = false))
  }

  @Test fun `a partial that changes rating is not accepted early`() {
    assertNull(stabilizer.offer(listOf("dos"), false))
    now = 200
    assertNull(stabilizer.offer(listOf("tres"), false))
    now = 400 // 400 ms since "dos" but only 200 since "tres"
    assertNull(stabilizer.offer(listOf("tres"), false))
    now = 500
    assertEquals(Rating.Good, stabilizer.offer(listOf("tres"), false))
  }

  @Test fun `a partial that stops parsing resets the candidate`() {
    assertNull(stabilizer.offer(listOf("uno"), false))
    now = 200
    assertNull(stabilizer.offer(listOf("hmm"), false))
    now = 350
    assertNull(stabilizer.offer(listOf("uno"), false))
    now = 649
    assertNull(stabilizer.offer(listOf("uno"), false))
    now = 650
    assertEquals(Rating.Again, stabilizer.offer(listOf("uno"), false))
  }

  @Test fun `a second partial with more words and the same rating confirms`() {
    assertNull(stabilizer.offer(listOf("cuatro"), false))
    now = 80
    assertEquals(Rating.Easy, stabilizer.offer(listOf("cuatro fácil"), false))
  }

  @Test fun `the final result is accepted immediately`() {
    assertEquals(Rating.Hard, stabilizer.offer(listOf("dos"), isFinal = true))
  }

  @Test fun `nothing recognised returns null so the session pauses`() {
    assertNull(stabilizer.offer(listOf("no sé"), false))
    now = 1_000
    assertNull(stabilizer.offer(listOf("no sé"), false))
    assertNull(stabilizer.offer(listOf("no sé"), isFinal = true))
    assertNull(stabilizer.offer(emptyList(), isFinal = true))
  }

  @Test fun `alternatives - top wins, lower ones count only when they agree`() {
    assertEquals(Rating.Good, parseRatingAlternatives(listOf("tres", "dos")))
    assertEquals(Rating.Hard, parseRatingAlternatives(listOf("tos", "dos", "dos.")))
    assertNull(parseRatingAlternatives(listOf("tos", "dos", "tres")))
    assertNull(parseRatingAlternatives(emptyList()))
  }

  @Test fun `reveal keywords match on any alternative`() {
    assertTrue(listOf("pues", "siguiente").any(::matchesRevealKeyword))
    assertTrue(matchesRevealKeyword("¡Ya!"))
    assertFalse(matchesRevealKeyword("estoy pensando"))
  }
}
