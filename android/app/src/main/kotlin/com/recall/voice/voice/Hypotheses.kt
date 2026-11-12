package com.recall.voice.voice

import com.recall.voice.api.Rating

/** Words that explicitly mean "show the answer / I'm ready / advance". */
private val REVEAL_KEYWORDS = setOf(
  "siguiente", "ya", "listo", "vale", "respuesta", "ok", "okay",
  "next", "answer", "ready", "go", "show",
)

fun matchesRevealKeyword(text: String): Boolean {
  val tokens = text.lowercase()
    .replace(Regex("[áàâ]"), "a").replace(Regex("[éèê]"), "e")
    .replace(Regex("[íì]"), "i").replace(Regex("[óòô]"), "o")
    .replace(Regex("[úù]"), "u")
    .split(Regex("[\\s,.!?¡¿]+"))
    .filter { it.isNotBlank() }
  return tokens.any { it in REVEAL_KEYWORDS }
}

/**
 * The rating meant by a recogniser's alternatives. The top hypothesis wins when it parses;
 * otherwise the lower alternatives count only if they agree with each other. Disagreement
 * yields null, which pauses rather than guessing.
 */
fun parseRatingAlternatives(hypotheses: List<String>): Rating? {
  if (hypotheses.isEmpty()) return null
  parseRating(hypotheses.first())?.let { return it }
  return hypotheses.drop(1).mapNotNull(::parseRating).distinct().singleOrNull()
}

/** How long a partial rating must stay the same before it counts. */
const val RATING_STABLE_MS = 300L

/**
 * Decides when a spoken rating is safe to accept. Ratings are data, so a partial result counts
 * only once it is stable: the same rating [windowMs] after it first appeared, or confirmed by a
 * later partial with more words that still parses to it. A final result is accepted at once.
 * A partial that parses to another rating, or to none, starts over.
 */
class RatingStabilizer(
  private val clock: () -> Long,
  private val windowMs: Long = RATING_STABLE_MS,
  private val parse: (List<String>) -> Rating? = ::parseRatingAlternatives,
) {
  private var candidate: Rating? = null
  private var since = 0L
  private var text: String? = null

  fun offer(hypotheses: List<String>, isFinal: Boolean): Rating? {
    val parsed = parse(hypotheses)
    if (isFinal) return parsed
    val now = clock()
    val top = hypotheses.firstOrNull()
    if (parsed == null) {
      candidate = null; text = null
      return null
    }
    if (parsed != candidate) {
      candidate = parsed; since = now; text = top
      return null
    }
    val confirmedBySecondPartial = top != null && top != text && text != null
    return if (now - since >= windowMs || confirmedBySecondPartial) parsed else null
  }
}
