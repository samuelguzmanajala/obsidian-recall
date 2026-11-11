package com.recall.voice.ui

import android.app.Activity
import android.view.WindowManager
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Pause
import androidx.compose.foundation.BorderStroke
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.recall.voice.R
import com.recall.voice.api.DueItem
import com.recall.voice.api.Rating
import com.recall.voice.session.ErrorKind
import com.recall.voice.session.SessionState
import com.recall.voice.session.Station
import com.recall.voice.session.StationStatus
import com.recall.voice.session.currentItem
import com.recall.voice.ui.theme.Recall
import com.recall.voice.voice.formatIntervalDays

/** Least height the bottom controls occupy, so the card never jumps between phases at the default text size. */
private val ControlsMinHeight = 132.dp

/** Fixed part of a rating cell: roundel, gaps and the controls' padding. Its two text lines come on top. */
private val RatingCellChrome = 90.dp

/** Least height of the status area: one sentence above a full-width resume button, reserved in every phase. */
private val StatusMinHeight = 104.dp

@Composable
fun SessionScreen(
  state: SessionState,
  deckName: String,
  stations: List<Station>,
  onManualRating: (Rating) -> Unit,
  onSkipToAnswer: () -> Unit,
  onResumeVoice: () -> Unit,
  onRetry: () -> Unit,
  onExit: () -> Unit,
) {
  KeepScreenOn(state.currentItem != null && state !is SessionState.AwaitingConfirmation)
  val c = Recall.colors
  val (index, total) = progress(state, stations.size)

  Scaffold(
    topBar = {
      Column(Modifier.background(c.shell)) {
        ShellTopBar(
          title = deckName,
          navigation = {
            IconButton(onClick = onExit) {
              Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_exit))
            }
          },
          actions = {
            if (total > 0) Text(
              stringResource(R.string.session_progress, index.coerceAtMost(total), total),
              style = MaterialTheme.typography.titleLarge,
              color = c.onShell,
              modifier = Modifier.padding(end = 16.dp).clearAndSetSemantics {},
            )
          },
        )
        SessionLine(
          index = index,
          total = total,
          stations = stations,
          listening = state is SessionState.ListeningReveal || state is SessionState.ListeningRating,
          modifier = Modifier.padding(horizontal = 4.dp).padding(bottom = 8.dp),
        )
      }
    },
  ) { insets ->
    Column(Modifier.fillMaxSize().padding(insets)) {
      val item = state.currentItem
      when {
        item != null -> {
          val answerShown = state is SessionState.ReadingAnswer || state is SessionState.ListeningRating ||
            state is SessionState.AwaitingConfirmation || state is SessionState.Submitting
          val rejected = stations.count { it.status == StationStatus.Rejected }
          CardPanel(item, answerShown, Modifier.weight(1f))
          StatusArea(state, rejected, onResumeVoice)
          // Both phases share one least height that grows with the text size, so the rating row is
          // never cut and the card keeps its place when the answer is revealed.
          val type = MaterialTheme.typography
          val textLines = with(LocalDensity.current) { type.labelMedium.lineHeight.toDp() + type.titleMedium.lineHeight.toDp() }
          val controlsHeight = maxOf(ControlsMinHeight, RatingCellChrome + textLines)
          Box(Modifier.fillMaxWidth().heightIn(min = controlsHeight).padding(horizontal = 16.dp).padding(bottom = 12.dp)) {
            if (answerShown) RatingRow(item, (state as? SessionState.Submitting)?.rating, onManualRating)
            else OutlinedButton(
              onClick = onSkipToAnswer,
              shape = MaterialTheme.shapes.large,
              border = BorderStroke(3.dp, MaterialTheme.colorScheme.onSurface),
              colors = ButtonDefaults.outlinedButtonColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainer,
                contentColor = MaterialTheme.colorScheme.onSurface,
              ),
              modifier = Modifier.fillMaxWidth().height(controlsHeight - 12.dp),
            ) { Text(stringResource(R.string.session_show_answer), style = MaterialTheme.typography.titleLarge) }
          }
        }
        state is SessionState.Done -> DonePanel(state.totalReviewed, stations, onExit)
        state is SessionState.Error -> ErrorPanel(state, onRetry, onExit)
        else -> LoadingPanel()
      }
    }
  }
}

@Composable
private fun CardPanel(item: DueItem, answerShown: Boolean, modifier: Modifier) {
  val c = Recall.colors
  val forward = item.direction != "b-to-a"
  val questionLabel = stringResource(R.string.session_question)
  val answerLabel = stringResource(R.string.session_answer)
  Surface(
    color = c.card,
    contentColor = c.onCard,
    shape = MaterialTheme.shapes.large,
    border = if (c.cardEdge.isSpecified) BorderStroke(1.dp, c.cardEdge) else null,
    modifier = modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp),
  ) {
    Column(Modifier.verticalScroll(rememberScrollState()).padding(22.dp)) {
      CardText(
        markdown = if (forward) item.sideA else item.sideB,
        style = MaterialTheme.typography.headlineSmall,
        color = c.onCard,
        modifier = Modifier.semantics { heading(); contentDescription = questionLabel },
      )
      if (answerShown) {
        HorizontalDivider(Modifier.padding(vertical = 20.dp), thickness = 2.dp, color = c.cardRule)
        CardText(
          markdown = if (forward) item.sideB else item.sideA,
          style = MaterialTheme.typography.titleLarge.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.W500),
          color = c.onCard,
          modifier = Modifier.semantics { contentDescription = answerLabel },
        )
      }
    }
  }
}

/**
 * The status sentence, with room reserved under it in every phase: a rejected-review notice when
 * the server turned one down, and the full-width resume button while paused. The reserve keeps the
 * card still when the session pauses or resumes.
 */
@Composable
private fun StatusArea(state: SessionState, rejected: Int, onResumeVoice: () -> Unit) {
  val (icon: ImageVector, text: Int) = when (state) {
    is SessionState.ReadingQuestion ->
      if (state.preparingAudio) Icons.Filled.CloudDownload to R.string.session_preparing_audio
      else Icons.AutoMirrored.Filled.VolumeUp to R.string.session_reading_question
    is SessionState.ListeningReveal -> Icons.Filled.Mic to R.string.session_listening_reveal
    is SessionState.ReadingAnswer ->
      if (state.preparingAudio) Icons.Filled.CloudDownload to R.string.session_preparing_audio
      else Icons.AutoMirrored.Filled.VolumeUp to R.string.session_reading_answer
    is SessionState.ListeningRating -> Icons.Filled.Mic to R.string.session_listening_rating
    is SessionState.AwaitingConfirmation -> Icons.Filled.Pause to R.string.session_paused
    else -> Icons.Filled.CloudUpload to R.string.session_submitting
  }
  Column(
    Modifier.fillMaxWidth().heightIn(min = StatusMinHeight).padding(horizontal = 16.dp, vertical = 8.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
  ) {
    StatusRow(icon, stringResource(text), MaterialTheme.colorScheme.onSurfaceVariant, MaterialTheme.colorScheme.onSurface)
    if (rejected > 0) StatusRow(
      Icons.Filled.ErrorOutline,
      pluralStringResource(R.plurals.session_rejected_notice, rejected, rejected),
      MaterialTheme.colorScheme.error,
      MaterialTheme.colorScheme.error,
    )
    if (state is SessionState.AwaitingConfirmation) Button(
      onClick = onResumeVoice,
      shape = MaterialTheme.shapes.large,
      modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
    ) {
      Icon(Icons.Filled.Mic, contentDescription = null)
      Spacer(Modifier.width(10.dp))
      Text(stringResource(R.string.session_resume), style = MaterialTheme.typography.titleMedium)
    }
  }
}

@Composable
private fun StatusRow(icon: ImageVector, text: String, tint: Color, color: Color) {
  Row(
    Modifier.fillMaxWidth().padding(horizontal = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Icon(icon, contentDescription = null, tint = tint)
    Text(text, style = MaterialTheme.typography.titleMedium, color = color, modifier = Modifier.weight(1f))
  }
}

@Composable
private fun RatingRow(item: DueItem, submitting: Rating?, onRating: (Rating) -> Unit) {
  val p = item.preview
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    RatingCell(Rating.Again, "1", R.string.rating_again, p?.againDays, submitting, onRating, Modifier.weight(1f))
    RatingCell(Rating.Hard, "2", R.string.rating_hard, p?.hardDays, submitting, onRating, Modifier.weight(1f))
    RatingCell(Rating.Good, "3", R.string.rating_good, p?.goodDays, submitting, onRating, Modifier.weight(1f))
    RatingCell(Rating.Easy, "4", R.string.rating_easy, p?.easyDays, submitting, onRating, Modifier.weight(1f))
  }
}

/** A numbered roundel in the rating's line ink, with its name and the interval it leads to. */
@Composable
private fun RatingCell(
  rating: Rating,
  numeral: String,
  name: Int,
  days: Int?,
  submitting: Rating?,
  onRating: (Rating) -> Unit,
  modifier: Modifier,
) {
  val c = Recall.colors
  val label = stringResource(name)
  val interval = days?.let(::formatIntervalDays) ?: "—"
  val description = stringResource(R.string.rating_desc, numeral, label, interval)
  val dim by animateFloatAsState(if (submitting != null && submitting != rating) 0.35f else 1f, label = "dim")
  Column(
    modifier
      .alpha(dim)
      .clip(MaterialTheme.shapes.medium)
      .clickable(enabled = submitting == null, role = Role.Button) { onRating(rating) }
      .clearAndSetSemantics { contentDescription = description }
      .padding(vertical = 4.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Box(
      Modifier
        .size(64.dp)
        .border(4.dp, MaterialTheme.colorScheme.onSurface, CircleShape)
        .padding(4.dp)
        .background(c.ink(rating), CircleShape),
      contentAlignment = Alignment.Center,
    ) { Text(numeral, style = MaterialTheme.typography.headlineLarge, color = c.onInk(rating)) }
    Spacer(Modifier.height(6.dp))
    Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    Text(interval, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
  }
}

@Composable
private fun LoadingPanel() {
  Column(
    Modifier.fillMaxSize(),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
  ) {
    CircularProgressIndicator()
    Text(stringResource(R.string.session_fetching), style = MaterialTheme.typography.titleMedium)
  }
}

@Composable
private fun DonePanel(reviewed: Int, stations: List<Station>, onExit: () -> Unit) {
  Column(
    Modifier.fillMaxSize().padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
  ) {
    Text(
      stringResource(R.string.session_done_title),
      style = MaterialTheme.typography.headlineLarge,
      modifier = Modifier.semantics { heading() },
    )
    Text(
      if (reviewed == 0) stringResource(R.string.session_done_zero)
      else pluralStringResource(R.plurals.session_done_count, reviewed, reviewed),
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
    val confirmed = stations.filter { it.status == StationStatus.Confirmed }
    if (confirmed.isNotEmpty()) RatingTally(confirmed)
    Spacer(Modifier.height(12.dp))
    Button(onClick = onExit, modifier = Modifier.fillMaxWidth().height(64.dp), shape = MaterialTheme.shapes.large) {
      Text(stringResource(R.string.session_done_back), style = MaterialTheme.typography.titleMedium)
    }
  }
}

/** Confirmed reviews per rating: each roundel ink with its count, and the rating's name beneath. */
@Composable
private fun RatingTally(confirmed: List<Station>) {
  val c = Recall.colors
  Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
    for ((rating, name) in listOf(
      Rating.Again to R.string.rating_again,
      Rating.Hard to R.string.rating_hard,
      Rating.Good to R.string.rating_good,
      Rating.Easy to R.string.rating_easy,
    )) {
      val count = confirmed.count { it.rating == rating }
      val label = stringResource(name)
      val description = stringResource(R.string.session_done_tally_desc, label, count)
      Column(
        Modifier.clearAndSetSemantics { contentDescription = description },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        Box(Modifier.size(40.dp).background(c.ink(rating), CircleShape), contentAlignment = Alignment.Center) {
          Text(count.toString(), style = MaterialTheme.typography.labelLarge, color = c.onInk(rating))
        }
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
      }
    }
  }
}

@Composable
private fun ErrorPanel(error: SessionState.Error, onRetry: () -> Unit, onExit: () -> Unit) {
  Column(
    Modifier.fillMaxSize().padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
  ) {
    Text(
      stringResource(R.string.session_error_title),
      style = MaterialTheme.typography.headlineMedium,
      modifier = Modifier.semantics { heading() },
    )
    if (error.kind == ErrorKind.ReviewsNotSaved) {
      Text(
        stringResource(R.string.session_error_unsaved),
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.error,
      )
      if (error.message.isNotBlank()) Text(
        error.message,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    } else {
      Text(
        stringResource(if (error.kind == ErrorKind.VoiceUnavailable) R.string.session_error_voice else R.string.session_error_generic),
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.error,
      )
      if (error.message.isNotBlank()) Text(
        error.message,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    Text(
      stringResource(R.string.session_error_hint),
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(12.dp))
    Button(onClick = onRetry, modifier = Modifier.fillMaxWidth().height(64.dp), shape = MaterialTheme.shapes.large) {
      Text(stringResource(R.string.action_retry), style = MaterialTheme.typography.titleMedium)
    }
    OutlinedButton(onClick = onExit, modifier = Modifier.fillMaxWidth().height(56.dp), shape = MaterialTheme.shapes.large) {
      Text(stringResource(R.string.session_done_back), style = MaterialTheme.typography.titleMedium)
    }
  }
}

/** Current station and line length; once the session ends, every station counts as passed. */
private fun progress(state: SessionState, passed: Int): Pair<Int, Int> = when (state) {
  is SessionState.ReadingQuestion -> state.index to state.total
  is SessionState.ListeningReveal -> state.index to state.total
  is SessionState.ReadingAnswer -> state.index to state.total
  is SessionState.ListeningRating -> state.index to state.total
  is SessionState.AwaitingConfirmation -> state.index to state.total
  is SessionState.Submitting -> state.index to state.total
  is SessionState.Done -> (passed + 1) to passed
  is SessionState.Error -> (passed + 1) to passed
  else -> 0 to 0
}

@Composable
private fun KeepScreenOn(active: Boolean) {
  val context = LocalContext.current
  DisposableEffect(active) {
    val window = (context as? Activity)?.window
    if (active) window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
  }
}
