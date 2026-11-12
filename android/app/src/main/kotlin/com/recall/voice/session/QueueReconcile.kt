package com.recall.voice.session

import com.recall.voice.api.DueItem

/** A card this session already decided (pending, confirmed or rejected), as sent to the server. */
data class ReviewedCard(val studyItemId: String, val conceptId: String, val revision: Int?)

/**
 * Merges a fresh `GET /due` answer into the remaining [buffer].
 *
 * - Retained items keep their order and take the fresh copy (new revision, preview, voice text).
 * - Items missing from [fresh] are dropped only when [freshComplete] (the answer was not cut by
 *   the request limit); otherwise their absence proves nothing and they are kept.
 * - New items are appended in server order only when [appendNew]. A cut answer is a different
 *   random slice of a large queue each time, so appending from it would make the session grow
 *   with every refresh; by default new items are taken only from a complete answer.
 * - Never queued: the card on screen ([current]) or its other direction; a card already reviewed
 *   in this session at the same or a newer revision than the server reports (the answer predates
 *   our review, e.g. it is still pending); and the other direction of any card reviewed in this
 *   session (the server rejects it the same day).
 */
fun reconcileQueue(
  buffer: List<DueItem>,
  fresh: List<DueItem>,
  current: DueItem?,
  reviewed: List<ReviewedCard>,
  freshComplete: Boolean,
  appendNew: Boolean = freshComplete,
): List<DueItem> {
  fun excluded(item: DueItem): Boolean {
    if (current != null && (item.studyItemId == current.studyItemId || item.conceptId == current.conceptId)) return true
    return reviewed.any { r ->
      if (r.studyItemId == item.studyItemId) item.revision == null || r.revision == null || item.revision <= r.revision
      else r.conceptId == item.conceptId
    }
  }
  val freshById = LinkedHashMap<String, DueItem>()
  for (item in fresh) freshById.putIfAbsent(item.studyItemId, item)
  val retained = buffer.mapNotNull { old -> freshById[old.studyItemId] ?: old.takeUnless { freshComplete } }
  val retainedIds = retained.mapTo(HashSet()) { it.studyItemId }
  val appended = if (appendNew) freshById.values.filter { it.studyItemId !in retainedIds } else emptyList()
  return (retained + appended).filterNot(::excluded)
}

/** Decision-time hygiene: the other direction of a card just rated would be rejected today. */
fun dropSiblings(buffer: List<DueItem>, rated: DueItem): List<DueItem> =
  buffer.filterNot { it.conceptId == rated.conceptId }
