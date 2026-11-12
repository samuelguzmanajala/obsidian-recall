package com.recall.voice.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.material3.MaterialTheme
import androidx.test.core.app.ApplicationProvider
import com.recall.voice.ui.theme.RecallTheme
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Typesetting with the bundled JLaTeXMath assets, its fallback, and what TalkBack hears. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class FormulaTest {
  @get:Rule val compose = createComposeRule()

  private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()

  @Test fun `real formulas lay out with a fraction's height and depth`() {
    val inline = Typesetter.layout(context, "\\bar{x}=\\frac{\\sum_{i=1}^n{x_i}}{n}", display = false, sizePx = 60f, argb = -1)
    assertNotNull(inline)
    inline!!
    assertTrue("width ${inline.width}", inline.width > 60f)
    // A fraction rises above and hangs below the baseline.
    assertTrue("ascent ${inline.ascent}", inline.ascent > 40f)
    assertTrue("depth ${inline.depth}", inline.depth > 10f)
    val letter = Typesetter.layout(context, "X", display = false, sizePx = 60f, argb = -1)!!
    assertTrue("X has no depth: ${letter.depth}", letter.depth < 1f)
  }

  @Test fun `unreadable LaTeX gives no layout`() {
    assertNull(Typesetter.layout(context, "\\frac{1}{", display = false, sizePx = 60f, argb = -1))
    assertNull(Typesetter.layout(context, "\\notACommand{x}", display = true, sizePx = 60f, argb = -1))
  }

  @Test fun `formulas are described by their source and broken ones show it`() {
    compose.setContent {
      RecallTheme(dark = true) {
        CardText(
          markdown = "Media \$\\bar{x}\$ de \$n\$ valores.\n\n\$\$\n\\sum_{i=1}^n x_i\n\$\$\n\nRota: \$\\frac{1}{\$",
          style = MaterialTheme.typography.titleLarge,
          color = Color.Black,
        )
      }
    }
    compose.onNodeWithContentDescription("\\bar{x}", useUnmergedTree = true).assertExists()
    compose.onAllNodesWithContentDescription("n", useUnmergedTree = true).assertCountEquals(1)
    compose.onNodeWithContentDescription("\\sum_{i=1}^n x_i", useUnmergedTree = true).assertExists()
    compose.onNodeWithText("\$\\frac{1}{\$", substring = true).assertExists()
  }
}
