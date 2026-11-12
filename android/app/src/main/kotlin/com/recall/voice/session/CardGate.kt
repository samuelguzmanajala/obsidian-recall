package com.recall.voice.session

/** Unconfirmed reviews allowed before the session waits at the card boundary. */
const val MAX_PENDING_REVIEWS = 3

/** Consecutive failed sends after which the session stops instead of starting another card. */
const val SENDER_FAILURE_LIMIT = 3

enum class CardGate {
  /** Start the next card. */
  Proceed,
  /** Too much unconfirmed work but the sender is still trying: keep showing "Saving…". */
  Wait,
  /** The sender keeps failing: stop and show the error. Pending reviews stay in the journal. */
  Stop,
}

/** May the session start another card, given what the background sender reports? */
fun cardGate(
  pending: Int,
  consecutiveFailures: Int,
  maxPending: Int = MAX_PENDING_REVIEWS,
  failureLimit: Int = SENDER_FAILURE_LIMIT,
): CardGate = when {
  consecutiveFailures >= failureLimit -> CardGate.Stop
  pending > maxPending -> CardGate.Wait
  else -> CardGate.Proceed
}

/** Before Done: the journal must be empty, unless the sender keeps failing. */
fun drainGate(pending: Int, consecutiveFailures: Int, failureLimit: Int = SENDER_FAILURE_LIMIT): CardGate = when {
  consecutiveFailures >= failureLimit -> CardGate.Stop
  pending > 0 -> CardGate.Wait
  else -> CardGate.Proceed
}
