package com.recall.voice.voice

import com.recall.voice.api.Rating

/**
 * Map a recognized speech utterance to a Rating, or null if no match.
 * Supports digits 1-4 plus Spanish and English number words and rating words.
 * Pure function — fully unit-testable.
 */
fun parseRating(spoken: String?): Rating? {
  if (spoken.isNullOrBlank()) return null
  val tokens = tokenize(spoken)
  if (tokens.isEmpty()) return null

  for (token in tokens) {
    when (token) {
      in AGAIN_TOKENS -> return Rating.Again
      in HARD_TOKENS -> return Rating.Hard
      in GOOD_TOKENS -> return Rating.Good
      in EASY_TOKENS -> return Rating.Easy
    }
  }
  return null
}

private fun tokenize(s: String): List<String> =
  s.lowercase()
    .replace(Regex("[áàâ]"), "a")
    .replace(Regex("[éèê]"), "e")
    .replace(Regex("[íì]"), "i")
    .replace(Regex("[óòô]"), "o")
    .replace(Regex("[úù]"), "u")
    .replace("ñ", "n")
    .split(Regex("[\\s,.!?;:¡¿]+"))
    .filter { it.isNotBlank() }

private val AGAIN_TOKENS = setOf("1", "uno", "one", "again", "otra", "mal")
private val HARD_TOKENS = setOf("2", "dos", "two", "hard", "dificil", "duro")
private val GOOD_TOKENS = setOf("3", "tres", "three", "good", "bien", "si", "ok", "okay", "vale")
private val EASY_TOKENS = setOf("4", "cuatro", "four", "easy", "facil", "sencillo", "trivial")
