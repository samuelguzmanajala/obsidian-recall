package com.recall.voice.session

import android.os.SystemClock
import android.util.Log

/** Phase timings for a review session. Read with `adb logcat -s RecallTiming`. */
object Timing {
  private const val TAG = "RecallTiming"

  /** Falls back to the JVM clock so pure code that traces can run in plain unit tests. */
  fun now(): Long = runCatching { SystemClock.elapsedRealtime() }.getOrElse { System.nanoTime() / 1_000_000 }

  fun log(phase: String, startedAt: Long, detail: String = "") {
    runCatching { Log.i(TAG, "$phase ${now() - startedAt}ms $detail".trim()) }
  }

  fun mark(message: String) {
    runCatching { Log.i(TAG, message) }
  }
}
