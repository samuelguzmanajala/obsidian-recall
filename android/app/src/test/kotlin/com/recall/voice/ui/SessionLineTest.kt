package com.recall.voice.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionLineTest {

  @Test fun shortSessionShowsWholeLine() {
    assertEquals(1, lineWindowStart(index = 5, total = 10, max = 16))
    assertEquals(1, lineWindowStart(index = 16, total = 16, max = 16))
  }

  @Test fun longSessionKeepsRiderAThirdIn() {
    assertEquals(1, lineWindowStart(index = 3, total = 23, max = 16))
    assertEquals(5, lineWindowStart(index = 10, total = 23, max = 16))
  }

  @Test fun windowStopsAtTheEndOfTheLine() {
    assertEquals(8, lineWindowStart(index = 23, total = 23, max = 16))
    // Done: the rider is one past the last station.
    assertEquals(8, lineWindowStart(index = 24, total = 23, max = 16))
  }

  @Test fun windowNeverExceedsMax() {
    for (total in 1..60) for (index in 1..total + 1) {
      val max = 16
      val first = lineWindowStart(index, total, max)
      val last = minOf(total, first + max - 1)
      assert(last - first + 1 <= max)
      if (index <= total) assert(index in first..last) { "index $index total $total window $first..$last" }
    }
  }

  @Test fun phoneWidthFitsAboutSixteenStations() {
    // 411 dp phone, 4 dp outer padding each side, 16 dp line inset each side.
    val span = 411f - 2 * 4f - 2 * 16f
    val count = stationsThatFit(span, MinStationPitch.value)
    assertEquals(17, count)
    assert(span / (count - 1) >= MinStationPitch.value)
  }

  @Test fun pitchIsAtLeastRingPlusStationPlusGap() {
    assertEquals(22.5f, MinStationPitch.value, 0.001f)
    for (span in listOf(100f, 250f, 371f, 600f, 900f)) {
      val count = stationsThatFit(span, MinStationPitch.value)
      assert(span / (count - 1) >= MinStationPitch.value) { "span $span count $count" }
      // One more would break the pitch.
      assert(span / count < MinStationPitch.value)
    }
  }

  @Test fun tinyOrDegenerateSpanStillDrawsTwoStations() {
    assertEquals(2, stationsThatFit(10f, 22.5f))
    assertEquals(2, stationsThatFit(0f, 22.5f))
    assertEquals(2, stationsThatFit(100f, 0f))
  }
}
