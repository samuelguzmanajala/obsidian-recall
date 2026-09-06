package com.recall.voice.session

import com.recall.voice.api.Rating
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceDecisionTest {
  @Test fun `silence waits indefinitely until explicit resume and recognition`() = runTest {
    val resume = CompletableDeferred<Unit>()
    var listens = 0
    val decision = async { awaitVoiceDecision({ if (listens++ == 0) null else Rating.Good }, { resume.await() }) }
    runCurrent(); advanceTimeBy(120_000); runCurrent()
    assertFalse(decision.isCompleted)
    assertEquals(1, listens)
    resume.complete(Unit); runCurrent()
    assertEquals(Rating.Good, decision.await())
  }

  @Test fun `cancelling a paused voice session produces no decision`() = runTest {
    val resume = CompletableDeferred<Unit>()
    var decided = false
    val decision = async { awaitVoiceDecision({ null }, { resume.await() }); decided = true }
    runCurrent(); decision.cancel(); runCurrent()
    assertFalse(decided)
  }
}
