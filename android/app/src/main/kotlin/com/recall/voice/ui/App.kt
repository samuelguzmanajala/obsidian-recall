package com.recall.voice.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.recall.voice.api.RecallApi
import com.recall.voice.session.SessionViewModel
import com.recall.voice.session.ReviewOutbox
import com.recall.voice.settings.AppConfig
import com.recall.voice.settings.AppSettings
import com.recall.voice.voice.RemoteAudioPlayer
import com.recall.voice.voice.SttEngine
import com.recall.voice.voice.TtsEngine
import kotlinx.coroutines.launch
import java.util.Locale

private sealed interface Route {
  data object Home : Route
  data object Settings : Route
  data class Session(val deckId: String?) : Route
}

@Composable
fun App() {
  val context = LocalContext.current
  val settingsRepo = remember { AppSettings(context) }
  val loadedConfig by settingsRepo.config.collectAsState(initial = null)
  val config = loadedConfig ?: return
  val scope = rememberCoroutineScope()

  var micGranted by remember {
    mutableStateOf(
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
        == PackageManager.PERMISSION_GRANTED,
    )
  }
  val micLauncher = rememberLauncherForActivityResult(
    ActivityResultContracts.RequestPermission(),
  ) { granted -> micGranted = granted }

  LaunchedEffect(Unit) {
    if (!micGranted) micLauncher.launch(Manifest.permission.RECORD_AUDIO)
  }

  // Initial route: Home if config is set, otherwise force Settings.
  val configured = config.baseUrl.isNotBlank() && config.token.isNotBlank()
  var route by remember {
    mutableStateOf<Route>(if (configured) Route.Home else Route.Settings)
  }

  when (val r = route) {
    Route.Home -> {
      val api = remember(config.baseUrl, config.token) { RecallApi(config.baseUrl, config.token) }
      val outbox = remember(config.baseUrl) { ReviewOutbox(context.filesDir, config.baseUrl) }
      DeckBrowserScreen(
        api = api,
        recoverReviews = { outbox.recover(api::postReviews) },
        rejectedReviewCount = outbox::rejectedCount,
        onOpenSettings = { route = Route.Settings },
        onStartSession = { deckId ->
          if (micGranted) route = Route.Session(deckId)
          else micLauncher.launch(Manifest.permission.RECORD_AUDIO)
        },
      )
    }
    Route.Settings -> {
      SettingsScreen(
        config = config,
        micGranted = micGranted,
        canGoBack = configured,
        onUpdate = { newCfg -> scope.launch { settingsRepo.update { newCfg } } },
        onRequestMic = { micLauncher.launch(Manifest.permission.RECORD_AUDIO) },
        onBack = { route = Route.Home },
      )
    }
    is Route.Session -> {
      SessionRoute(
        config = config,
        deckId = r.deckId,
        onExit = { route = Route.Home },
      )
    }
  }
}

@Composable
private fun SessionRoute(config: AppConfig, deckId: String?, onExit: () -> Unit) {
  val context = LocalContext.current
  val vm = remember(config, deckId) {
    val tts = TtsEngine(context.applicationContext)
    val stt = SttEngine(context.applicationContext)
    val api = RecallApi(config.baseUrl, config.token)
    val remote = if (config.useRemoteTts) RemoteAudioPlayer(context.applicationContext, api) else null
    SessionViewModel(
      api = api,
      tts = tts,
      stt = stt,
      locale = Locale.forLanguageTag(config.locale.ifBlank { "es-ES" }),
      remotePlayer = remote,
      deckId = deckId,
      outbox = ReviewOutbox(context.filesDir, config.baseUrl),
    )
  }
  DisposableEffect(vm) {
    onDispose { vm.stop() }
  }
  LaunchedEffect(vm) { vm.start() }

  val state by vm.state.collectAsState()
  SessionScreen(
    state = state,
    onManualRating = vm::submitManual,
    onSkipToAnswer = vm::skipToAnswerNow,
    onResumeVoice = vm::resumeVoice,
    onExit = { vm.stop(); onExit() },
  )
}
