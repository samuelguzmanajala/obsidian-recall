package com.recall.voice.voice

import com.recall.voice.api.Rating
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class RatingParserTest {

  @Test fun `digit 1 maps to Again`() = assertEquals(Rating.Again, parseRating("1"))
  @Test fun `digit 2 maps to Hard`() = assertEquals(Rating.Hard, parseRating("2"))
  @Test fun `digit 3 maps to Good`() = assertEquals(Rating.Good, parseRating("3"))
  @Test fun `digit 4 maps to Easy`() = assertEquals(Rating.Easy, parseRating("4"))

  @Test fun `Spanish words map correctly`() {
    assertEquals(Rating.Again, parseRating("uno"))
    assertEquals(Rating.Hard, parseRating("dos"))
    assertEquals(Rating.Good, parseRating("tres"))
    assertEquals(Rating.Easy, parseRating("cuatro"))
  }

  @Test fun `English words map correctly`() {
    assertEquals(Rating.Again, parseRating("again"))
    assertEquals(Rating.Hard, parseRating("hard"))
    assertEquals(Rating.Good, parseRating("good"))
    assertEquals(Rating.Easy, parseRating("easy"))
  }

  @Test fun `accents are normalized`() {
    assertEquals(Rating.Hard, parseRating("difícil"))
    assertEquals(Rating.Easy, parseRating("fácil"))
    assertEquals(Rating.Good, parseRating("sí"))
  }

  @Test fun `case is ignored`() {
    assertEquals(Rating.Good, parseRating("OK"))
    assertEquals(Rating.Easy, parseRating("EASY"))
  }

  @Test fun `surrounding noise does not break recognition`() {
    assertEquals(Rating.Good, parseRating("um, three please"))
    assertEquals(Rating.Easy, parseRating("¡cuatro!"))
    assertEquals(Rating.Hard, parseRating("creo que dos"))
  }

  @Test fun `null and blank return null`() {
    assertNull(parseRating(null))
    assertNull(parseRating(""))
    assertNull(parseRating("   "))
  }

  @Test fun `unrecognized words return null`() {
    assertNull(parseRating("hola que tal"))
    assertNull(parseRating("siguiente"))
    assertNull(parseRating("zorba"))
  }

  @Test fun `first match wins when multiple ratings appear`() {
    // "uno" appears before "tres" in token order → Again wins
    assertEquals(Rating.Again, parseRating("uno o tres"))
  }
}
