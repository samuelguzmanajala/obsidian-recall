package com.recall.voice.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import com.recall.voice.api.DeckTreeNode
import com.recall.voice.api.DueItem
import com.recall.voice.api.PreviewIntervals
import com.recall.voice.api.Rating
import com.recall.voice.session.SessionState
import com.recall.voice.session.Station
import com.recall.voice.session.StationStatus
import com.recall.voice.settings.AppConfig
import com.recall.voice.ui.theme.RecallTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Renders every screen state to `.impeccable/review/<name>-<dark|light>.png` so the design can be
 * reviewed without a device. Spanish locale, a 411 x 891 dp phone at xxhdpi.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "es-w411dp-h891dp-xxhdpi")
class ScreenshotTest(private val dark: Boolean) {

  companion object {
    @JvmStatic
    @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
    fun themes(): List<Array<Any>> = listOf(arrayOf(true), arrayOf(false))
  }

  @get:Rule val compose = createComposeRule()

  private val outDir = File(System.getProperty("recall.review.dir") ?: "build/review").apply { mkdirs() }

  private fun shoot(name: String, fontScale: Float = 1f, content: @Composable () -> Unit) {
    compose.setContent {
      val density = LocalDensity.current
      CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
        RecallTheme(dark = dark) {
          Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() }
        }
      }
    }
    compose.waitForIdle()
    val file = File(outDir, "$name-${if (dark) "dark" else "light"}.png")
    compose.onRoot().captureRoboImage(file.absolutePath)
  }

  // Session

  private val card = DueItem(
    studyItemId = "s1",
    conceptId = "c1",
    sideA = "¿Qué diferencia hay entre `val` y `var` en Kotlin?",
    sideB = "`val` declara una referencia de solo lectura; `var` permite reasignarla.\n\n" +
      "- `val` se asigna una sola vez\n" +
      "- `var` admite nuevas asignaciones\n" +
      "- Ninguna de las dos hace **inmutable** el objeto",
    direction = "a-to-b",
    due = "2026-11-11T08:00:00Z",
    reps = 4,
    lapses = 1,
    stability = 6.2,
    difficulty = 5.1,
    voiceQuestion = "¿Qué diferencia hay entre val y var en Kotlin?",
    voiceAnswer = "val declara una referencia de solo lectura; var permite reasignarla.",
    preview = PreviewIntervals(againDays = 0, hardDays = 2, goodDays = 6, easyDays = 15),
  )

  private fun confirmed(vararg ratings: Rating) = ratings.map { Station(it, StationStatus.Confirmed) }

  private val history = confirmed(Rating.Good, Rating.Good, Rating.Again, Rating.Easy, Rating.Hard, Rating.Good)

  private fun session(
    name: String,
    state: SessionState,
    history: List<Station> = this.history,
    fontScale: Float = 1f,
  ) = shoot(name, fontScale) {
    SessionScreen(
      state = state,
      deckName = "Kotlin",
      stations = history,
      onManualRating = {},
      onSkipToAnswer = {},
      onResumeVoice = {},
      onRetry = {},
      onExit = {},
    )
  }

  @Test fun sessionRating() = session("session-rating", SessionState.ListeningRating(card, 7, 23))

  @Test fun sessionQuestion() = session("session-question", SessionState.ListeningReveal(card, 7, 23))

  @Test fun sessionRatingFont130() = session("session-rating-font130", SessionState.ListeningRating(card, 7, 23), fontScale = 1.3f)

  @Test fun sessionQuestionFont130() = session("session-question-font130", SessionState.ListeningReveal(card, 7, 23), fontScale = 1.3f)

  @Test fun sessionPaused() = session("session-paused", SessionState.AwaitingConfirmation(card, 7, 23))

  @Test fun sessionError() = session(
    "session-error",
    SessionState.Error("failed to connect to /192.168.1.10 (port 27124) after 10000ms"),
  )

  @Test fun sessionDone() = session(
    "session-done",
    SessionState.Done(23),
    history = List(23) { i ->
      Station(listOf(Rating.Good, Rating.Good, Rating.Easy, Rating.Hard, Rating.Good, Rating.Again)[i % 6], StationStatus.Confirmed)
    },
  )

  /** Paused while a rejected review is on the line: the tallest status area. */
  @Test fun sessionPausedRejected() = session(
    "session-paused-rejected",
    SessionState.AwaitingConfirmation(card, 7, 23),
    history = confirmed(Rating.Good, Rating.Good, Rating.Again) +
      Station(Rating.Easy, StationStatus.Rejected) +
      confirmed(Rating.Hard, Rating.Good),
  )

  @Test fun sessionVoiceError() = session(
    "session-voice-error",
    SessionState.Error("TTS engine not available", com.recall.voice.session.ErrorKind.VoiceUnavailable),
  )

  /** Confirmed, one rejected (fourth), and the last two still being saved; the status area counts the rejection. */
  @Test fun sessionPendingRejected() = session(
    "session-pending-rejected",
    SessionState.ListeningReveal(card, 7, 23),
    history = confirmed(Rating.Good, Rating.Good, Rating.Again) +
      Station(Rating.Easy, StationStatus.Rejected) +
      Station(Rating.Hard, StationStatus.Pending) +
      Station(Rating.Good, StationStatus.Pending),
  )

  @Test fun sessionPreparingAudio() = session(
    "session-preparing-audio",
    SessionState.ReadingQuestion(card, 7, 23, preparingAudio = true),
  )

  @Test fun sessionNotSaved() = session(
    "session-not-saved",
    SessionState.Error("failed to connect to /192.168.1.10 (port 27124)", com.recall.voice.session.ErrorKind.ReviewsNotSaved),
    history = history + Station(Rating.Good, StationStatus.Pending) + Station(Rating.Easy, StationStatus.Pending),
  )

  /** Real formulas from the user's statistics deck, mixed with Spanish text, a list, display math and an image. */
  private val formulaCard = card.copy(
    studyItemId = "s2",
    sideA = "¿Por qué la media recortada se divide entre \$n-2p\$ y no entre \$n\$?",
    sideB = "Porque se elimina un número fijo \$p\$ de valores en cada extremo. " +
      "La media es \$\\bar{x}=\\frac{\\sum_{i=1}^n{x_i}}{n}\$ y la recortada usa solo lo que queda:\n\n" +
      "- Características (Features / \$X\$)\n" +
      "- Ponderada: \$\\bar{x}_w=\\frac{\\sum_{i=1}^nW_{i}X_i}{\\sum_{i=1}^nW_{i}}\$\n" +
      "- Cuesta \$5 y \$10, sin fórmula\n\n" +
      "\$\$\n\\bar{x}_t=\\frac{1}{n-2p}\\sum_{i=p+1}^{n-p}x_{(i)}\n\$\$\n\n" +
      "![[media-recortada.png]]",
  )

  @Test fun sessionFormulas() = session("session-formulas", SessionState.ListeningRating(formulaCard, 7, 23))

  @Test fun sessionFormulasFont130() = session(
    "session-formulas-font130",
    SessionState.ListeningRating(formulaCard, 7, 23),
    fontScale = 1.3f,
  )

  /**
   * The whole answer at full length, since the session card scrolls: checks nothing below the fold
   * is clipped, including a display formula wider than the card.
   */
  @Test fun sessionFormulasFull() = shoot("session-formulas-full") {
    val c = com.recall.voice.ui.theme.Recall.colors
    androidx.compose.foundation.layout.Box(
      Modifier.padding(16.dp).background(c.card, MaterialTheme.shapes.large).padding(22.dp),
    ) {
      CardText(
        markdown = formulaCard.sideB + "\n\nUna fórmula ancha:\n\n" +
          "\$\$\nS^2=\\frac{1}{n-1}\\sum_{i=1}^{n}\\left(x_i-\\bar{x}\\right)^2=\\frac{1}{n-1}\\left(\\sum_{i=1}^{n}x_i^2-n\\bar{x}^2\\right)\n\$\$\n\n" +
          "Y una que no se puede leer: \$\\frac{1}{\$",
        style = MaterialTheme.typography.titleLarge.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.W500),
        color = c.onCard,
      )
    }
  }

  // Home

  private fun deck(id: String, name: String, due: Int, new: Int, vararg children: DeckTreeNode) = DeckTreeNode(
    id = id,
    name = name,
    totalItems = due + new + 20 + children.sumOf { it.totalItems },
    dueItems = due + children.sumOf { it.dueItems },
    newItems = new + children.sumOf { it.newItems },
    children = children.toList(),
  )

  private val decks = listOf(
    deck(
      "filo", "Filosofía", 0, 0,
      deck("etica", "Ética", 0, 0, deck("kant", "Kant", 3, 0), deck("aristoteles", "Aristóteles", 2, 1)),
      deck("episte", "Epistemología", 1, 0, deck("hume", "Hume", 4, 1)),
    ),
    deck(
      "prog", "Programación", 0, 0,
      deck("kotlin", "Kotlin", 2, 0, deck("corrutinas", "Corrutinas y concurrencia estructurada", 4, 2), deck("compose", "Jetpack Compose", 0, 3)),
      deck("sql", "SQL", 3, 3),
    ),
    deck("idiomas", "Idiomas", 0, 0, deck("aleman", "Alemán", 0, 12)),
    deck("eco", "Economía y teoría monetaria", 2, 0),
  )

  private fun home(
    name: String,
    decks: List<DeckTreeNode> = emptyList(),
    loading: Boolean = false,
    error: String? = null,
    collapsed: Set<String> = emptySet(),
  ) = shoot(name) {
    DeckBrowserContent(
      decks = decks,
      loading = loading,
      refreshing = false,
      error = error,
      rejected = 0,
      collapsed = collapsed,
      onToggle = {},
      onRefresh = {},
      onRetry = {},
      onOpenSettings = {},
      onStartSession = { _, _ -> },
    )
  }

  @Test fun homeDecks() = home("home-decks", decks, error = "timeout", collapsed = setOf("episte", "idiomas"))

  @Test fun homeEmpty() = home("home-empty")

  @Test fun homeError() = home("home-error", error = "failed to connect to /192.168.1.10 (port 27124) after 10000ms")

  @Test fun homeLoading() = home("home-loading", loading = true)

  // Settings

  @Test fun settingsConfigured() = shoot("settings-configured") {
    SettingsScreen(
      config = AppConfig(baseUrl = "http://100.79.144.106:27124", token = "s3cr3t-token-value", locale = "es-ES"),
      micGranted = true,
      canGoBack = true,
      onUpdate = {},
      onRequestMic = {},
      onBack = {},
    )
  }

  @Test fun settingsFirstRun() = shoot("settings-first-run") {
    SettingsScreen(
      config = AppConfig(),
      micGranted = false,
      canGoBack = false,
      onUpdate = {},
      onRequestMic = {},
      onBack = {},
    )
  }
}
