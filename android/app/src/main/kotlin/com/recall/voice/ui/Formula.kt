package com.recall.voice.ui

import android.content.Context
import android.graphics.Paint
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import com.recall.voice.R
import com.recall.voice.ui.theme.RecallColors
import org.scilab.forge.jlatexmath.TeXConstants
import org.scilab.forge.jlatexmath.TeXFormula
import org.scilab.forge.jlatexmath.TeXIcon
import ru.noties.jlatexmath.JLatexMathAndroid
import ru.noties.jlatexmath.awt.AndroidGraphics2D
import kotlin.math.max
import kotlin.math.min

/**
 * Computer Modern sits smaller on its em than Encode Sans (x-height about 0.43 against 0.53), so a
 * formula is set this much larger than the text around it for the two to read at the same size.
 */
private const val MathToText = 1.18f

/** A display formula wider than the card shrinks to this fraction at most, then scrolls sideways. */
private const val MinDisplayScale = 0.7f

/** A formula laid out by JLaTeXMath at a given pixel size and colour, ready to draw. */
class Formula internal constructor(private val icon: TeXIcon) {
  val width: Float = icon.trueIconWidth
  val depth: Float = icon.trueIconDepth

  /** Extent above the baseline. */
  val ascent: Float = icon.trueIconHeight - depth
  private val graphics = AndroidGraphics2D()

  /** Draws with the formula's left edge at x = 0 and its baseline at y = 0, scaled by [scale]. */
  fun draw(canvas: android.graphics.Canvas, scale: Float = 1f) {
    val save = canvas.save()
    canvas.scale(scale, scale)
    canvas.translate(0f, -ascent)
    graphics.setCanvas(canvas)
    icon.paintIcon(null, graphics, 0, 0)
    canvas.restoreToCount(save)
  }
}

/**
 * Lays out TeX with JLaTeXMath, entirely offline: its parser tables and Computer Modern fonts ship
 * as assets of the library. Layouts are cached, failures too, so recomposition never re-parses.
 */
object Typesetter {
  private object Failed

  private val cache = LruCache<String, Any>(128)
  private val lock = Any()

  @Volatile private var initialised = false

  /** Loads the parser tables and fonts so the first card with a formula does not pay for it. */
  fun warmUp(context: Context) {
    layout(context, "x", display = false, sizePx = 16f, argb = 0xFF000000.toInt())
  }

  /** The formula for [latex], or null when JLaTeXMath cannot parse or lay it out. */
  fun layout(context: Context, latex: String, display: Boolean, sizePx: Float, argb: Int): Formula? {
    val key = "$display|$sizePx|$argb|$latex"
    cache.get(key)?.let { return it as? Formula }
    // JLaTeXMath reads a missing closing brace at the end as an empty group; treat it as an error.
    if (!bracesBalance(latex)) {
      cache.put(key, Failed)
      return null
    }
    val formula = synchronized(lock) {
      if (!initialised) {
        JLatexMathAndroid.init(context.applicationContext)
        initialised = true
      }
      try {
        val icon = TeXFormula(latex).TeXIconBuilder()
          .setStyle(if (display) TeXConstants.STYLE_DISPLAY else TeXConstants.STYLE_TEXT)
          .setSize(sizePx)
          // Without true values the icon pads itself by 0.18 em on every side, outside its metrics.
          .setTrueValues(true)
          .setFGColor(ru.noties.jlatexmath.awt.Color(argb))
          .build()
        Formula(icon).takeIf { it.width > 0f && it.ascent + it.depth > 0f }
      } catch (e: Exception) {
        null
      } catch (e: StackOverflowError) {
        null
      } catch (e: LinkageError) {
        // The library's assets failed to load: show sources rather than crash the session.
        null
      }
    }
    cache.put(key, formula ?: Failed)
    return formula
  }
}

/** Whether every `{` in [latex] has its `}`, ignoring escaped braces. */
internal fun bracesBalance(latex: String): Boolean {
  var depth = 0
  var i = 0
  while (i < latex.length) {
    when (latex[i]) {
      '\\' -> i++
      '{' -> depth++
      '}' -> if (--depth < 0) return false
    }
    i++
  }
  return depth == 0
}

/** Ascent and descent of the card typeface at [fontPx], as the text layout sees them. */
private class TextMetrics(val ascent: Int, val descent: Int) {
  /** Height of the text's centre above the baseline: where a TextCenter placeholder is centred. */
  val centre: Float get() = -(ascent + descent) / 2f
  val height: Int get() = descent - ascent
}

@Composable
private fun rememberTextMetrics(fontPx: Float): TextMetrics {
  val context = LocalContext.current
  return remember(fontPx) {
    val paint = Paint().apply {
      typeface = context.resources.getFont(R.font.encode_sans)
      textSize = fontPx
    }
    val fm = paint.fontMetricsInt
    TextMetrics(fm.ascent, fm.descent)
  }
}

/**
 * A run of card text with inline formulas typeset in it. Each formula is one placeholder that
 * wraps with the words around it; its baseline sits on the text's baseline, and one wider than the
 * line shrinks to fit. A formula JLaTeXMath cannot read shows its source in monospace instead.
 */
@Composable
fun InlineMathText(spans: List<MdInline>, style: TextStyle, color: Color, c: RecallColors, modifier: Modifier = Modifier) {
  BoxWithConstraints(modifier) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val fontPx = with(density) { style.fontSize.toPx() }
    val metrics = rememberTextMetrics(fontPx)
    val argb = color.toArgb()
    val maxWidth = if (constraints.hasBoundedWidth) constraints.maxWidth.toFloat() else Float.MAX_VALUE
    val laid = remember(spans, fontPx, argb, maxWidth) {
      spans.map { span ->
        if (span !is MdMath) return@map null
        val formula = Typesetter.layout(context, span.latex, display = false, sizePx = fontPx * MathToText, argb = argb)
          ?: return@map null
        val scale = min(1f, maxWidth / formula.width)
        // Symmetric about the text's centre, so TextCenter alignment puts both baselines together.
        val half = max(formula.ascent * scale - metrics.centre, formula.depth * scale + metrics.centre)
        InlineFormula(span.latex, formula, scale, formula.width * scale, 2 * half)
      }
    }
    val inline = mutableMapOf<String, InlineTextContent>()
    var tall = false
    val text = buildAnnotatedString {
      spans.forEachIndexed { index, span ->
        val formula = laid[index]
        when {
          span !is MdMath -> append(annotate(listOf(span), c))
          formula == null -> append(annotate(listOf(MdSpan("$" + span.latex + "$", code = true)), c))
          else -> {
            val id = "math$index"
            appendInlineContent(id, span.latex)
            if (formula.height > metrics.height) tall = true
            inline[id] = InlineTextContent(
              Placeholder((formula.width / fontPx).em, (formula.height / fontPx).em, PlaceholderVerticalAlign.TextCenter),
            ) {
              Canvas(Modifier.fillMaxSize().semantics { contentDescription = formula.latex }) {
                drawFormula(formula.formula, formula.scale, size.height / 2 + metrics.centre)
              }
            }
          }
        }
      }
    }
    // The theme's fixed line height would squeeze a tall formula into an ordinary line, so a
    // paragraph holding one takes the typeface's own line spacing, which grows around it.
    Text(
      text,
      style = if (tall) style.copy(lineHeight = TextUnit.Unspecified) else style,
      color = color,
      inlineContent = inline,
    )
  }
}

private class InlineFormula(val latex: String, val formula: Formula, val scale: Float, val width: Float, val height: Float)

private fun DrawScope.drawFormula(formula: Formula, scale: Float, baseline: Float) {
  drawIntoCanvas { canvas ->
    val native = canvas.nativeCanvas
    val save = native.save()
    native.translate(0f, baseline)
    formula.draw(native, scale)
    native.restoreToCount(save)
  }
}

/**
 * Display math, centred on its own. One wider than the card shrinks to [MinDisplayScale], and
 * scrolls sideways past that so it stays legible.
 */
@Composable
fun DisplayMath(latex: String, style: TextStyle, color: Color, codeStyle: TextStyle, c: RecallColors) {
  val context = LocalContext.current
  val density = LocalDensity.current
  val fontPx = with(density) { style.fontSize.toPx() }
  val argb = color.toArgb()
  val formula = remember(latex, fontPx, argb) {
    Typesetter.layout(context, latex, display = true, sizePx = fontPx * MathToText, argb = argb)
  }
  if (formula == null) {
    CodePanel("$$$latex$$", codeStyle, color, c)
    return
  }
  BoxWithConstraints(Modifier.fillMaxWidth().semantics { contentDescription = latex }) {
    val available = constraints.maxWidth.toFloat()
    val scale = (available / formula.width).coerceIn(MinDisplayScale, 1f)
    val width = with(density) { (formula.width * scale).toDp() }
    val height = with(density) { ((formula.ascent + formula.depth) * scale).toDp() }
    val scrolls = formula.width * scale > available
    Box(
      Modifier.fillMaxWidth().then(if (scrolls) Modifier.horizontalScroll(rememberScrollState()) else Modifier),
      contentAlignment = Alignment.Center,
    ) {
      Canvas(Modifier.size(width, height)) { drawFormula(formula, scale, formula.ascent * scale) }
    }
  }
}

/** The source of [spans] with styles applied; formulas fall back to their source in monospace. */
internal fun annotate(spans: List<MdInline>, c: RecallColors): AnnotatedString = buildAnnotatedString {
  for (span in spans) when (span) {
    is MdSpan -> append(styled(span, c))
    is MdMath -> append(styled(MdSpan("$" + span.latex + "$", code = true), c))
  }
}
