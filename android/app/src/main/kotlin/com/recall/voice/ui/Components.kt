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
import androidx.compose.foundation.border
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.pluralStringResource
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

/** Radius of the interchange ring that marks the current station. */
private val RingRadius = 13.dp

/** Radius of a passed station's dot. */
private val StationRadius = 6.5.dp

/** Clear space kept between the ring and the station just left. */
private val StationGap = 3.dp

/** Inset of the first and last station from the line's ends. */
private val LineInset = 16.dp

/** Closest two stations may sit: the ring never covers the station the rider just left. */
val MinStationPitch = RingRadius + StationRadius + StationGap

/**
 * How many stations fit along a line whose stations can spread over [span] (the distance from the
 * first to the last station), keeping them at least [minPitch] apart. Never fewer than two.
 */
fun stationsThatFit(span: Float, minPitch: Float): Int =
  if (minPitch <= 0f || span <= 0f) 2 else (kotlin.math.floor(span / minPitch).toInt() + 1).coerceAtLeast(2)

/** First station drawn for a session of [total] cards when the rider is at [index] (both 1-based). */
fun lineWindowStart(index: Int, total: Int, max: Int): Int =
  if (total <= max) 1 else (index - max / 3).coerceIn(1, total - max + 1)

/**
 * The session as a line. Each passed segment takes the ink of the rating given at the station it
 * leaves, so the line fills with your answers. What the server made of a rating is told by shape as
 * well as colour: confirmed is a filled dot with a full-width inked segment; still being saved is a
 * hollow ring with a thin inked segment; rejected is a porcelain dot cut by a slash, its segment
 * left as bare track. The current station is an interchange ring; the rest are ticks.
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
  val pending = stations.count { it.status == StationStatus.Pending }
  val rejected = stations.count { it.status == StationStatus.Rejected }
  val description = buildList {
    add(stringResource(R.string.session_progress_desc, index.coerceAtMost(total), total))
    if (pending > 0) add(pluralStringResource(R.plurals.session_line_pending, pending, pending))
    if (rejected > 0) add(pluralStringResource(R.plurals.session_line_rejected, rejected, rejected))
  }.joinToString(". ")
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
    val pad = LineInset.toPx()
    val max = stationsThatFit(size.width - 2 * pad, MinStationPitch.toPx())
    val first = lineWindowStart(index, total, max)
    val last = minOf(total, first + max - 1)
    val y = size.height / 2
    val span = (last - first).coerceAtLeast(1)
    fun x(station: Float) = pad + (size.width - 2 * pad) * ((station - first) / span).coerceIn(-0.1f, 1.1f)
    val left = if (first == 1) pad else 0f
    val right = if (last == total) size.width - pad else size.width
    val stroke = 8.dp.toPx()
    val thin = 3.dp.toPx()

    drawLine(c.track, Offset(left, y), Offset(right, y), stroke, StrokeCap.Round)
    val here = x(position.coerceAtMost(total.toFloat()))

    // Passed segments, each in the ink of the station it leaves; the one into the rider follows the ring.
    for (from in maxOf(1, first - 1) until minOf(index, last + 1)) {
      val station = stations.getOrNull(from - 1) ?: continue
      // Off the window's left edge the segment also covers the track's rounded end.
      val start = if (from < first) left - stroke / 2 else x(from.toFloat())
      val end = if (from + 1 >= index) here else x((from + 1).toFloat())
      if (end <= start) continue
      when (station.status) {
        StationStatus.Confirmed -> drawLine(c.ink(station.rating), Offset(start, y), Offset(end, y), stroke, StrokeCap.Butt)
        StationStatus.Pending -> drawLine(c.ink(station.rating), Offset(start, y), Offset(end, y), thin, StrokeCap.Butt)
        StationStatus.Rejected -> Unit
      }
    }

    for (station in first..last) {
      val at = Offset(x(station.toFloat()), y)
      when {
        station < index -> drawStation(stations.getOrNull(station - 1), at, c)
        station > index -> {
          val reach = 6.dp.toPx()
          drawLine(c.onShell, Offset(at.x, y - reach), Offset(at.x, y + reach), 2.5.dp.toPx(), StrokeCap.Round)
        }
      }
    }
    if (index in first..last) {
      val at = Offset(here, y)
      if (listening) drawCircle(c.onShell.copy(alpha = 0.35f * (1f - pulse.value)), (RingRadius.value + 9 * pulse.value).dp.toPx(), at)
      drawCircle(c.onShell, RingRadius.toPx(), at)
      drawCircle(c.shell, 7.dp.toPx(), at)
    }
  }
}

private fun DrawScope.drawStation(station: Station?, at: Offset, c: RecallColors) {
  val radius = StationRadius.toPx()
  // A midnight keyline parts the dot from a segment in the same ink.
  drawCircle(c.shell, radius + 1.5.dp.toPx(), at)
  when (station?.status) {
    null -> drawCircle(c.onShell, radius, at)
    StationStatus.Confirmed -> drawCircle(c.ink(station.rating), radius, at)
    StationStatus.Pending -> {
      val ring = 2.5.dp.toPx()
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
        is MdBlock.Paragraph -> InlineMathText(block.spans, style, color, c)
        is MdBlock.Heading -> InlineMathText(block.spans, style.copy(fontWeight = FontWeight.W800), color, c)
        is MdBlock.Item -> Row(Modifier.padding(start = (block.depth * 20).dp)) {
          // On the first line's baseline, which a tall formula pushes down.
          Text(block.marker, style = style, color = c.onCardMuted, modifier = Modifier.width(28.dp).alignByBaseline())
          InlineMathText(block.spans, style, color, c, Modifier.alignByBaseline())
        }
        is MdBlock.Code -> CodePanel(block.text, CardCodeStyle, color, c)
        is MdBlock.Math -> DisplayMath(block.latex, style, color, CardCodeStyle, c)
        is MdBlock.Image -> ImagePlaceholder(block, c)
      }
    }
  }
}

/** Monospace for code inside card content: the one place the system leaves Encode Sans. */
private val CardCodeStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 15.sp, lineHeight = 22.sp)

/** Block code, or a formula that could not be typeset, on the card-code tone; scrolls sideways. */
@Composable
internal fun CodePanel(text: String, style: TextStyle, color: Color, c: RecallColors) {
  Text(
    text,
    style = style,
    color = color,
    softWrap = false,
    modifier = Modifier
      .fillMaxWidth()
      .background(c.cardCode, MaterialTheme.shapes.small)
      .horizontalScroll(rememberScrollState())
      .padding(12.dp),
  )
}

/**
 * Where an embedded image goes until the server serves attachments: an image icon and a sentence
 * naming the file, inside a keyline so it reads as a missing picture rather than card text.
 */
@Composable
private fun ImagePlaceholder(image: MdBlock.Image, c: RecallColors) {
  Row(
    Modifier
      .fillMaxWidth()
      .border(2.dp, c.cardRule, MaterialTheme.shapes.small)
      .padding(horizontal = 16.dp, vertical = 14.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(Icons.Outlined.Image, contentDescription = null, tint = c.onCardMuted)
    Text(
      stringResource(R.string.card_image_unavailable, image.fileName),
      style = MaterialTheme.typography.bodyLarge,
      color = c.onCardMuted,
    )
  }
}

/** One plain span with its emphasis, code and highlight styles. */
internal fun styled(span: MdSpan, c: RecallColors): AnnotatedString = buildAnnotatedString {
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
