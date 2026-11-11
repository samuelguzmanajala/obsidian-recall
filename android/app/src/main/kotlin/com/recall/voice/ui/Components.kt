package com.recall.voice.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.recall.voice.R
import com.recall.voice.session.Station
import com.recall.voice.session.StationStatus
import com.recall.voice.ui.theme.Recall
import com.recall.voice.ui.theme.RecallColors

/** The midnight bar every screen shares. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShellTopBar(
  title: String,
  navigation: @Composable () -> Unit = {},
  actions: @Composable () -> Unit = {},
) {
  val c = Recall.colors
  TopAppBar(
    title = { Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1) },
    navigationIcon = navigation,
    actions = { actions() },
    colors = TopAppBarDefaults.topAppBarColors(
      containerColor = c.shell,
      titleContentColor = c.onShell,
      navigationIconContentColor = c.onShell,
      actionIconContentColor = c.onShell,
    ),
  )
}

/** How many stations fit before the line has to scroll with the rider. */
private const val MAX_STATIONS = 25

/** First station drawn for a session of [total] cards when the rider is at [index] (both 1-based). */
fun lineWindowStart(index: Int, total: Int, max: Int = MAX_STATIONS): Int =
  if (total <= max) 1 else (index - max / 3).coerceIn(1, total - max + 1)

/**
 * The session as a line. A passed station shows the rating given there and what the server made
 * of it: a filled dot in the rating's ink once confirmed, a hollow ring in that ink while it is
 * still being saved, and a porcelain dot cut by a slash when the server rejected it (shape, not
 * only colour, tells them apart). The current station is an interchange ring; the rest are ticks.
 */
@Composable
fun SessionLine(
  index: Int,
  total: Int,
  stations: List<Station>,
  listening: Boolean,
  modifier: Modifier = Modifier,
) {
  val c = Recall.colors
  val description = stringResource(R.string.session_progress_desc, index.coerceAtMost(total), total)
  val position by animateFloatAsState(index.toFloat(), tween(320), label = "station")
  val pulse: State<Float> = if (listening) {
    rememberInfiniteTransition(label = "listening").animateFloat(
      0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Restart), label = "halo",
    )
  } else remember { androidx.compose.runtime.mutableFloatStateOf(0f) }

  Canvas(
    modifier
      .fillMaxWidth()
      .height(44.dp)
      .clearAndSetSemantics {
        contentDescription = description
        if (total > 0) progressBarRangeInfo = ProgressBarRangeInfo(index.toFloat(), 1f..total.toFloat())
      },
  ) {
    if (total <= 0) return@Canvas
    val first = lineWindowStart(index, total)
    val last = minOf(total, first + MAX_STATIONS - 1)
    val pad = 16.dp.toPx()
    val y = size.height / 2
    val span = (last - first).coerceAtLeast(1)
    fun x(station: Float) = pad + (size.width - 2 * pad) * ((station - first) / span).coerceIn(-0.1f, 1.1f)
    val left = if (first == 1) pad else 0f
    val right = if (last == total) size.width - pad else size.width
    val stroke = 8.dp.toPx()

    drawLine(c.track, Offset(left, y), Offset(right, y), stroke, StrokeCap.Round)
    val here = x(position.coerceAtMost(total.toFloat()))
    if (here > left) drawLine(c.onShellMuted, Offset(left, y), Offset(here, y), stroke, StrokeCap.Round)

    for (station in first..last) {
      val at = Offset(x(station.toFloat()), y)
      when {
        station < index -> drawStation(stations.getOrNull(station - 1), at, c)
        station > index -> drawCircle(c.onShell, 2.5.dp.toPx(), at)
      }
    }
    if (index in first..last) {
      val at = Offset(here, y)
      if (listening) drawCircle(c.onShell.copy(alpha = 0.35f * (1f - pulse.value)), (13 + 9 * pulse.value).dp.toPx(), at)
      drawCircle(c.onShell, 13.dp.toPx(), at)
      drawCircle(c.shell, 7.dp.toPx(), at)
    }
  }
}

private fun DrawScope.drawStation(station: Station?, at: Offset, c: RecallColors) {
  val radius = 6.5.dp.toPx()
  when (station?.status) {
    null -> drawCircle(c.onShell, radius, at)
    StationStatus.Confirmed -> drawCircle(c.ink(station.rating), radius, at)
    StationStatus.Pending -> {
      val ring = 2.5.dp.toPx()
      drawCircle(c.shell, radius, at)
      drawCircle(c.ink(station.rating), radius - ring / 2, at, style = Stroke(ring))
    }
    StationStatus.Rejected -> {
      drawCircle(c.onShell, radius, at)
      val reach = radius * 0.72f
      drawLine(c.shell, Offset(at.x - reach, at.y + reach), Offset(at.x + reach, at.y - reach), 2.5.dp.toPx(), StrokeCap.Round)
    }
  }
}

/** One side of a card, rendered from its Markdown source. */
@Composable
fun CardText(markdown: String, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
  val c = Recall.colors
  val blocks = remember(markdown) { parseMarkdown(markdown) }
  SelectionContainer(modifier) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
      for (block in blocks) when (block) {
        is MdBlock.Paragraph -> Text(annotate(block.spans, c), style = style, color = color)
        is MdBlock.Heading -> Text(annotate(block.spans, c), style = style.copy(fontWeight = FontWeight.W800), color = color)
        is MdBlock.Item -> Row(Modifier.padding(start = (block.depth * 20).dp)) {
          Text(block.marker, style = style, color = c.onCardMuted, modifier = Modifier.width(28.dp))
          Text(annotate(block.spans, c), style = style, color = color)
        }
        is MdBlock.Code -> Text(
          block.text,
          style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 15.sp, lineHeight = 22.sp),
          color = color,
          softWrap = false,
          modifier = Modifier
            .fillMaxWidth()
            .background(c.cardCode, MaterialTheme.shapes.small)
            .horizontalScroll(rememberScrollState())
            .padding(12.dp),
        )
      }
    }
  }
}

private fun annotate(spans: List<MdSpan>, c: RecallColors): AnnotatedString = buildAnnotatedString {
  for (span in spans) {
    val style = SpanStyle(
      fontWeight = if (span.bold) FontWeight.W800 else null,
      fontStyle = if (span.italic) FontStyle.Italic else null,
      fontFamily = if (span.code) FontFamily.Monospace else null,
      background = when {
        span.code -> c.cardCode
        span.mark -> c.cardMark
        else -> Color.Unspecified
      },
    )
    withStyle(style) { append(span.text) }
  }
}
