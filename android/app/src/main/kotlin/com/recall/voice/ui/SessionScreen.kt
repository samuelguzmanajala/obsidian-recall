package com.recall.voice.ui

import android.app.Activity
import android.view.WindowManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.recall.voice.api.DueItem
import com.recall.voice.api.Rating
import com.recall.voice.session.SessionState
import com.recall.voice.session.currentItem
import com.recall.voice.voice.formatIntervalDays

@Composable
fun SessionScreen(
  state: SessionState,
  onManualRating: (Rating) -> Unit,
  onSkipToAnswer: () -> Unit,
  onExit: () -> Unit,
  onResumeVoice: () -> Unit = {},
) {
  KeepScreenOn(active = state !is SessionState.Idle && state !is SessionState.Done && state !is SessionState.Error && state !is SessionState.AwaitingConfirmation)

  Column(
    modifier = Modifier.fillMaxSize().padding(20.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Header(state = state, onExit = onExit)
    if (state is SessionState.AwaitingConfirmation) {
      Button(onClick = onResumeVoice) { Text("Reanudar escucha") }
    }

    Box(modifier = Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
      when (state) {
        SessionState.Idle -> Text("Listo.")
        SessionState.Fetching -> Text("Cargando cards…")
        is SessionState.Error -> Text("Error: ${state.message}", textAlign = TextAlign.Center)
        is SessionState.Done -> DoneCard(reviewed = state.totalReviewed, onExit = onExit)
        else -> CardArea(state = state)
      }
    }

    val item = state.currentItem
    val canSkipToAnswer = state is SessionState.ReadingQuestion || state is SessionState.ListeningReveal
    val canRate = state is SessionState.ReadingAnswer ||
      state is SessionState.AwaitingConfirmation ||
      state is SessionState.ListeningRating ||
      state is SessionState.Submitting

    if (item != null && (canSkipToAnswer || canRate)) {
      ControlButtons(
        item = item,
        showSkipToAnswer = canSkipToAnswer,
        showRating = canRate,
        onRating = onManualRating,
        onSkipToAnswer = onSkipToAnswer,
      )
    } else {
      // Reserve the same vertical footprint to avoid layout jumps
      androidx.compose.foundation.layout.Spacer(modifier = Modifier.height(160.dp))
    }
  }
}

@Composable
private fun Header(state: SessionState, onExit: () -> Unit) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    val (idx, total) = progress(state)
    Text(
      text = if (total > 0) "$idx / $total" else " ",
      style = MaterialTheme.typography.titleMedium,
    )
    Text(text = stateLabel(state), style = MaterialTheme.typography.bodyMedium)
    TextButton(onClick = onExit) { Text("Salir") }
  }
  if (state is SessionState.ReadingQuestion ||
    state is SessionState.ListeningReveal ||
    state is SessionState.ReadingAnswer ||
    state is SessionState.ListeningRating ||
    state is SessionState.Submitting
  ) {
    val (idx, total) = progress(state)
    LinearProgressIndicator(
      progress = { if (total > 0) idx.toFloat() / total.toFloat() else 0f },
      modifier = Modifier.fillMaxWidth(),
    )
  }
}

@Composable
private fun CardArea(state: SessionState) {
  val item: DueItem = state.currentItem ?: return
  val showAnswer = state is SessionState.ReadingAnswer ||
    state is SessionState.AwaitingConfirmation ||
    state is SessionState.ListeningRating ||
    state is SessionState.Submitting

  Card(modifier = Modifier.fillMaxWidth().padding(8.dp)) {
    Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
      Text("Pregunta", style = MaterialTheme.typography.labelMedium)
      Text(item.voiceQuestion, style = MaterialTheme.typography.headlineSmall)
      if (showAnswer) {
        Text("Respuesta", style = MaterialTheme.typography.labelMedium)
        Text(item.voiceAnswer, style = MaterialTheme.typography.headlineSmall)
      }
    }
  }
}

@Composable
private fun ControlButtons(
  item: DueItem,
  showSkipToAnswer: Boolean,
  showRating: Boolean,
  onRating: (Rating) -> Unit,
  onSkipToAnswer: () -> Unit,
) {
  val p = item.preview
  val again = p?.let { formatIntervalDays(it.againDays) }
  val hard = p?.let { formatIntervalDays(it.hardDays) }
  val good = p?.let { formatIntervalDays(it.goodDays) }
  val easy = p?.let { formatIntervalDays(it.easyDays) }

  Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
    if (showSkipToAnswer) {
      androidx.compose.material3.OutlinedButton(
        onClick = onSkipToAnswer,
        modifier = Modifier.fillMaxWidth().height(140.dp),
      ) {
        Text("▶▶  Mostrar respuesta")
      }
    }
    if (showRating) {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        RatingButton("1 Again", again, Modifier.weight(1f)) { onRating(Rating.Again) }
        RatingButton("2 Hard",  hard,  Modifier.weight(1f)) { onRating(Rating.Hard) }
      }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        RatingButton("3 Good",  good,  Modifier.weight(1f)) { onRating(Rating.Good) }
        RatingButton("4 Easy",  easy,  Modifier.weight(1f)) { onRating(Rating.Easy) }
      }
    }
  }
}

@Composable
private fun RatingButton(label: String, interval: String?, modifier: Modifier, onClick: () -> Unit) {
  Button(
    onClick = onClick,
    modifier = modifier.height(72.dp),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 6.dp),
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text(label, style = MaterialTheme.typography.titleMedium)
      Text(
        text = interval ?: "—",
        style = MaterialTheme.typography.bodyMedium,
      )
    }
  }
}

@Composable
private fun DoneCard(reviewed: Int, onExit: () -> Unit) {
  Column(
    modifier = Modifier.fillMaxWidth(),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Text("Sesión completa", style = MaterialTheme.typography.headlineSmall)
    Text("$reviewed cards reviewed")
    Button(onClick = onExit) { Text("Volver") }
  }
}

private fun progress(state: SessionState): Pair<Int, Int> = when (state) {
  is SessionState.ReadingQuestion -> state.index to state.total
  is SessionState.ListeningReveal -> state.index to state.total
  is SessionState.ReadingAnswer -> state.index to state.total
  is SessionState.ListeningRating -> state.index to state.total
  is SessionState.AwaitingConfirmation -> state.index to state.total
  is SessionState.Submitting -> state.index to state.total
  else -> 0 to 0
}

private fun stateLabel(state: SessionState): String = when (state) {
  SessionState.Idle -> ""
  SessionState.Fetching -> "Cargando…"
  is SessionState.ReadingQuestion -> "📢 Pregunta"
  is SessionState.ListeningReveal -> "🎤 Habla para ver respuesta"
  is SessionState.ReadingAnswer -> "📢 Respuesta"
  is SessionState.ListeningRating -> "🎤 ¿1, 2, 3 o 4?"
  is SessionState.AwaitingConfirmation -> "En pausa: elige una valoracion. Nada se ha enviado."
  is SessionState.Submitting -> "Enviando…"
  is SessionState.Done -> "Hecho"
  is SessionState.Error -> "Error"
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
