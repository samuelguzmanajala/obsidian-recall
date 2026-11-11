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
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Pause
import androidx.compose.foundation.BorderStroke
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
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
import com.recall.voice.session.currentItem
import com.recall.voice.ui.theme.Recall
import com.recall.voice.voice.formatIntervalDays

/** Height the bottom controls always occupy, so the card never jumps between phases. */
private val ControlsHeight = 132.dp

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
          CardPanel(item, answerShown, Modifier.weight(1f))
          StatusLine(state, onResumeVoice)
          Box(Modifier.fillMaxWidth().height(ControlsHeight).padding(horizontal = 16.dp).padding(bottom = 12.dp)) {
            if (answerShown) RatingRow(item, (state as? SessionState.Submitting)?.rating, onManualRating)
            else OutlinedButton(
              onClick = onSkipToAnswer,
              shape = MaterialTheme.shapes.large,
              border = BorderStroke(3.dp, MaterialTheme.colorScheme.onSurface),
              colors = ButtonDefaults.outlinedButtonColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainer,
                contentColor = MaterialTheme.colorScheme.onSurface,
              ),
              modifier = Modifier.fillMaxSize(),
            ) { Text(stringResource(R.string.session_show_answer), style = MaterialTheme.typography.titleLarge) }
          }
        }
        state is SessionState.Done -> DonePanel(state.totalReviewed, onExit)
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

@Composable
private fun StatusLine(state: SessionState, onResumeVoice: () -> Unit) {
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
  Row(
    Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 20.dp, vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(
      stringResource(text),
      style = MaterialTheme.typography.titleMedium,
      color = MaterialTheme.colorScheme.onSurface,
      modifier = Modifier.weight(1f),
    )
    if (state is SessionState.AwaitingConfirmation) {
      FilledTonalButton(onClick = onResumeVoice) { Text(stringResource(R.string.session_resume)) }
    }
  }
}

@Composable
private fun RatingRow(item: DueItem, submitting: Rating?, onRating: (Rating) -> Unit) {
  val p = item.preview
  Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
private fun DonePanel(reviewed: Int, onExit: () -> Unit) {
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
    Spacer(Modifier.height(12.dp))
    Button(onClick = onExit, modifier = Modifier.fillMaxWidth().height(64.dp), shape = MaterialTheme.shapes.large) {
      Text(stringResource(R.string.session_done_back), style = MaterialTheme.typography.titleMedium)
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
      Text(error.message, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.error)
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
