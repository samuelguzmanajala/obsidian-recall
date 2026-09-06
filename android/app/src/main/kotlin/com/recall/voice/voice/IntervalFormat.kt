package com.recall.voice.voice

/**
 * Mirror of plugin's `formatInterval()` so what the user sees on the buttons
 * matches what they see in Obsidian.
 *
 *   <1d → "<10m"
 *   1..29d → "Xd"
 *   30..364d → "Xmo"
 *   ≥365d → "Xy" (one decimal)
 */
fun formatIntervalDays(days: Int): String {
  if (days < 1) return "<10m"
  if (days < 30) return "${days}d"
  if (days < 365) return "${(days / 30.0).toInt()}mo"
  val years = (days / 365.0 * 10).toInt() / 10.0
  return "${years}y"
}
