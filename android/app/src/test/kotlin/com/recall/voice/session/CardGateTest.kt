package com.recall.voice.session

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CardGateTest {
  @Test fun `healthy sender with up to three pending proceeds`() {
    for (pending in 0..3) assertEquals(CardGate.Proceed, cardGate(pending, 0))
  }

  @Test fun `more than three pending waits while the sender is still trying`() {
    assertEquals(CardGate.Wait, cardGate(4, 0))
    assertEquals(CardGate.Wait, cardGate(4, 2))
  }

  @Test fun `an isolated failure does not stop the session`() {
    assertEquals(CardGate.Proceed, cardGate(1, 1))
    assertEquals(CardGate.Proceed, cardGate(2, 2))
  }

  @Test fun `a sender that keeps failing stops the session whatever is pending`() {
    assertEquals(CardGate.Stop, cardGate(1, 3))
    assertEquals(CardGate.Stop, cardGate(4, 5))
  }

  @Test fun `done waits for an empty journal`() {
    assertEquals(CardGate.Proceed, drainGate(0, 0))
    assertEquals(CardGate.Wait, drainGate(1, 0))
    assertEquals(CardGate.Wait, drainGate(1, 2))
    assertEquals(CardGate.Stop, drainGate(1, 3))
  }
}
