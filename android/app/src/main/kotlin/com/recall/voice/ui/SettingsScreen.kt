package com.recall.voice.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.recall.voice.R
import com.recall.voice.api.RecallApi
import com.recall.voice.settings.AppConfig
import com.recall.voice.settings.VOICE_SPEEDS
import kotlinx.coroutines.launch

private sealed interface TestStatus {
  data object Testing : TestStatus
  data object Connected : TestStatus
  data class Failed(val reason: String) : TestStatus
}

private val SpeedLabels = mapOf(1f to R.string.settings_speed_100, 1.25f to R.string.settings_speed_125, 1.5f to R.string.settings_speed_150)

private val Languages = listOf("es-ES" to R.string.settings_lang_es, "en-US" to R.string.settings_lang_en)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
  config: AppConfig,
  micGranted: Boolean,
  canGoBack: Boolean,
  onUpdate: (AppConfig) -> Unit,
  onRequestMic: () -> Unit,
  onBack: () -> Unit,
  onClearAudio: suspend () -> Unit = {},
) {
  // The loaded config seeds the editor once. Asynchronous persistence must not
  // overwrite a newer keystroke with an older DataStore emission.
  var baseUrl by remember { mutableStateOf(config.baseUrl) }
  var token by remember { mutableStateOf(config.token) }
  var locale by remember { mutableStateOf(config.locale) }
  var defaultRating by remember { mutableStateOf(config.defaultRatingOnTimeout) }
  var useRemoteTts by remember { mutableStateOf(config.useRemoteTts) }
  var voiceSpeed by remember { mutableStateOf(config.voiceSpeed) }
  var audioCleared by remember { mutableStateOf(false) }
  var tokenVisible by remember { mutableStateOf(false) }
  var testStatus by remember { mutableStateOf<TestStatus?>(null) }
  val scope = rememberCoroutineScope()

  // Race-condition guard: only persist after the user actually edits a field.
  // Without this, the very first composition would call onUpdate with the
  // initial blank values BEFORE the saved config has finished loading from
  // DataStore, wiping the user's settings on every cold start.
  var hasEdited by remember { mutableStateOf(false) }
  LaunchedEffect(baseUrl, token, locale, defaultRating, useRemoteTts, voiceSpeed) {
    if (hasEdited) {
      onUpdate(AppConfig(baseUrl.trim(), token.trim(), locale, defaultRating, useRemoteTts, voiceSpeed))
    }
  }

  Scaffold(
    topBar = {
      ShellTopBar(
        title = stringResource(R.string.settings_title),
        navigation = {
          if (canGoBack) IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
          }
        },
      )
    },
  ) { insets ->
    Column(
      modifier = Modifier
        .fillMaxSize()
        .padding(insets)
        .consumeWindowInsets(insets)
        .imePadding()
        .verticalScroll(rememberScrollState())
        .padding(horizontal = 20.dp, vertical = 24.dp),
    ) {
      if (!canGoBack) {
        Text(
          stringResource(R.string.settings_intro),
          style = MaterialTheme.typography.bodyLarge,
          color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(28.dp))
      }

      SectionHeading(R.string.settings_server)
      OutlinedTextField(
        value = baseUrl,
        onValueChange = { hasEdited = true; baseUrl = it },
        label = { Text(stringResource(R.string.settings_url)) },
        placeholder = { Text(stringResource(R.string.settings_url_hint)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(
          keyboardType = KeyboardType.Uri,
          autoCorrectEnabled = false,
          imeAction = ImeAction.Next,
        ),
        modifier = Modifier.fillMaxWidth(),
      )
      Spacer(Modifier.height(12.dp))
      OutlinedTextField(
        value = token,
        onValueChange = { hasEdited = true; token = it },
        label = { Text(stringResource(R.string.settings_token)) },
        visualTransformation = if (tokenVisible) VisualTransformation.None else PasswordVisualTransformation(),
        singleLine = true,
        keyboardOptions = KeyboardOptions(
          keyboardType = KeyboardType.Password,
          autoCorrectEnabled = false,
          imeAction = ImeAction.Done,
        ),
        trailingIcon = {
          IconButton(onClick = { tokenVisible = !tokenVisible }) {
            Icon(
              if (tokenVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
              stringResource(if (tokenVisible) R.string.settings_token_hide else R.string.settings_token_show),
            )
          }
        },
        modifier = Modifier.fillMaxWidth(),
      )
      Spacer(Modifier.height(16.dp))
      OutlinedButton(
        onClick = {
          testStatus = TestStatus.Testing
          scope.launch {
            val err = runCatching { RecallApi(baseUrl.trim(), token.trim()).healthChecked() }
              .getOrElse { it.message ?: it::class.java.simpleName }
            testStatus = if (err == null) TestStatus.Connected else TestStatus.Failed(err)
          }
        },
        enabled = baseUrl.isNotBlank() && testStatus != TestStatus.Testing,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
      ) { Text(stringResource(R.string.settings_test), style = MaterialTheme.typography.titleSmall) }
      testStatus?.let { TestResult(it) }

      SectionDivider()
      SectionHeading(R.string.settings_voice)
      Text(
        stringResource(R.string.settings_language),
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurface,
      )
      Spacer(Modifier.height(10.dp))
      SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        Languages.forEachIndexed { i, (tag, label) ->
          SegmentedButton(
            selected = locale == tag,
            onClick = { hasEdited = true; locale = tag },
            shape = SegmentedButtonDefaults.itemShape(i, Languages.size),
            modifier = Modifier.heightIn(min = 48.dp),
          ) { Text(stringResource(label)) }
        }
      }
      Spacer(Modifier.height(16.dp))
      Row(
        Modifier
          .fillMaxWidth()
          .heightIn(min = 72.dp)
          .toggleable(
            value = useRemoteTts,
            role = Role.Switch,
            onValueChange = { hasEdited = true; useRemoteTts = it },
          )
          .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        Column(Modifier.weight(1f)) {
          Text(
            stringResource(R.string.settings_cloud_tts),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
          )
          Text(
            stringResource(R.string.settings_cloud_tts_desc),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
        Switch(checked = useRemoteTts, onCheckedChange = null)
      }
      Spacer(Modifier.height(12.dp))
      Text(
        stringResource(R.string.settings_voice_speed),
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurface,
      )
      Spacer(Modifier.height(10.dp))
      SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        VOICE_SPEEDS.forEachIndexed { i, speed ->
          SegmentedButton(
            selected = voiceSpeed == speed,
            onClick = { hasEdited = true; voiceSpeed = speed },
            shape = SegmentedButtonDefaults.itemShape(i, VOICE_SPEEDS.size),
            modifier = Modifier.heightIn(min = 48.dp),
          ) { Text(stringResource(SpeedLabels.getValue(speed))) }
        }
      }
      Spacer(Modifier.height(16.dp))
      OutlinedButton(
        onClick = { scope.launch { onClearAudio(); audioCleared = true } },
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
      ) { Text(stringResource(R.string.settings_clear_audio), style = MaterialTheme.typography.titleSmall) }
      Text(
        stringResource(if (audioCleared) R.string.settings_clear_audio_done else R.string.settings_clear_audio_desc),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
      )
      Spacer(Modifier.height(8.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(
          Icons.Filled.Info,
          contentDescription = null,
          tint = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.size(20.dp),
        )
        Text(
          stringResource(R.string.settings_unrecognized),
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }

      if (!micGranted) {
        SectionDivider()
        SectionHeading(R.string.settings_mic_title)
        Text(
          stringResource(R.string.settings_mic_desc),
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))
        FilledTonalButton(
          onClick = onRequestMic,
          shape = MaterialTheme.shapes.large,
          modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) { Text(stringResource(R.string.settings_mic_grant), style = MaterialTheme.typography.titleSmall) }
      }

      if (canGoBack) {
        Spacer(Modifier.height(32.dp))
        Button(
          onClick = onBack,
          shape = MaterialTheme.shapes.large,
          modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) { Text(stringResource(R.string.settings_done), style = MaterialTheme.typography.titleMedium) }
      }
    }
  }
}

@Composable
private fun SectionHeading(text: Int) {
  Text(
    stringResource(text),
    style = MaterialTheme.typography.titleMedium,
    color = MaterialTheme.colorScheme.onBackground,
    modifier = Modifier.padding(bottom = 12.dp).semantics { heading() },
  )
}

@Composable
private fun SectionDivider() {
  HorizontalDivider(Modifier.padding(top = 28.dp, bottom = 24.dp), color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
private fun TestResult(status: TestStatus) {
  Row(
    Modifier
      .fillMaxWidth()
      .heightIn(min = 48.dp)
      .padding(top = 8.dp)
      .semantics { liveRegion = LiveRegionMode.Polite },
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    val colors = MaterialTheme.colorScheme
    Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
      when (status) {
        TestStatus.Testing -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.5.dp)
        TestStatus.Connected -> Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = colors.onSurface)
        is TestStatus.Failed -> Icon(Icons.Filled.ErrorOutline, contentDescription = null, tint = colors.error)
      }
    }
    Text(
      when (status) {
        TestStatus.Testing -> stringResource(R.string.settings_testing)
        TestStatus.Connected -> stringResource(R.string.settings_test_ok)
        is TestStatus.Failed -> stringResource(R.string.settings_test_fail, status.reason)
      },
      style = MaterialTheme.typography.bodyMedium,
      color = if (status is TestStatus.Failed) colors.error else colors.onSurface,
      modifier = Modifier.weight(1f),
    )
  }
}
