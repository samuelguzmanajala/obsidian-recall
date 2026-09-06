package com.recall.voice.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.recall.voice.api.Rating
import com.recall.voice.api.RecallApi
import com.recall.voice.settings.AppConfig
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
  config: AppConfig,
  micGranted: Boolean,
  canGoBack: Boolean,
  onUpdate: (AppConfig) -> Unit,
  onRequestMic: () -> Unit,
  onBack: () -> Unit,
) {
  // The loaded config seeds the editor once. Asynchronous persistence must not
  // overwrite a newer keystroke with an older DataStore emission.
  var baseUrl by remember { mutableStateOf(config.baseUrl) }
  var token by remember { mutableStateOf(config.token) }
  var locale by remember { mutableStateOf(config.locale) }
  var defaultRating by remember { mutableStateOf(config.defaultRatingOnTimeout) }
  var useRemoteTts by remember { mutableStateOf(config.useRemoteTts) }
  var tokenVisible by remember { mutableStateOf(false) }
  var testStatus by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  // Race-condition guard: only persist after the user actually edits a field.
  // Without this, the very first composition would call onUpdate with the
  // initial blank values BEFORE the saved config has finished loading from
  // DataStore, wiping the user's settings on every cold start.
  var hasEdited by remember { mutableStateOf(false) }
  LaunchedEffect(baseUrl, token, locale, defaultRating, useRemoteTts) {
    if (hasEdited) {
      onUpdate(AppConfig(baseUrl.trim(), token.trim(), locale, defaultRating, useRemoteTts))
    }
  }

  Column(
    modifier = Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(20.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
      if (canGoBack) {
        TextButton(onClick = onBack) { Text("← Volver") }
      }
      Text(
        "Settings",
        style = androidx.compose.material3.MaterialTheme.typography.headlineMedium,
        modifier = Modifier.padding(start = if (canGoBack) 8.dp else 0.dp),
      )
    }
    Text(
      "Cliente de voz para sesiones de Recall desde el coche.",
      style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
    )

    OutlinedTextField(
      value = baseUrl,
      onValueChange = { hasEdited = true; baseUrl = it },
      label = { Text("Server URL") },
      placeholder = { Text("http://100.79.144.106:27124") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
    )

    OutlinedTextField(
      value = token,
      onValueChange = { hasEdited = true; token = it },
      label = { Text("API token") },
      visualTransformation = if (tokenVisible) VisualTransformation.None else PasswordVisualTransformation(),
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
    )
    TextButton(onClick = { tokenVisible = !tokenVisible }) {
      Text(if (tokenVisible) "Ocultar token" else "Mostrar token")
    }

    Text("Idioma", style = androidx.compose.material3.MaterialTheme.typography.titleSmall)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      FilterChip(selected = locale == "es-ES", onClick = { hasEdited = true; locale = "es-ES" }, label = { Text("Español") })
      FilterChip(selected = locale == "en-US", onClick = { hasEdited = true; locale = "en-US" }, label = { Text("English") })
    }

    Text(
      "Rating por defecto si STT no entiende",
      style = androidx.compose.material3.MaterialTheme.typography.titleSmall,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      FilterChip(selected = defaultRating == Rating.Again, onClick = { hasEdited = true; defaultRating = Rating.Again }, label = { Text("Again") })
      FilterChip(selected = defaultRating == Rating.Good, onClick = { hasEdited = true; defaultRating = Rating.Good }, label = { Text("Good") })
    }

    Text(
      "TTS de la nube (multilingüe)",
      style = androidx.compose.material3.MaterialTheme.typography.titleSmall,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      FilterChip(selected = useRemoteTts, onClick = { hasEdited = true; useRemoteTts = true }, label = { Text("Activado") })
      FilterChip(selected = !useRemoteTts, onClick = { hasEdited = true; useRemoteTts = false }, label = { Text("Solo on-device") })
    }

    if (!micGranted) {
      Button(onClick = onRequestMic, modifier = Modifier.fillMaxWidth()) {
        Text("Conceder permiso de micrófono")
      }
    }

    Button(
      onClick = {
        testStatus = "Probando…"
        scope.launch {
          val err = runCatching { RecallApi(baseUrl.trim(), token.trim()).healthChecked() }
            .getOrElse { it.message ?: it::class.java.simpleName }
          testStatus = if (err == null) "Conectado ✓" else "Sin conexión ✗  ($err)"
        }
      },
      modifier = Modifier.fillMaxWidth(),
      enabled = baseUrl.isNotBlank(),
    ) {
      Text("Probar conexión")
    }
    if (testStatus != null) Text(testStatus!!)

    if (canGoBack) {
      androidx.compose.foundation.layout.Spacer(modifier = Modifier.height(8.dp))
      Button(
        onClick = onBack,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text("← Volver al deck browser")
      }
    }
  }
}
