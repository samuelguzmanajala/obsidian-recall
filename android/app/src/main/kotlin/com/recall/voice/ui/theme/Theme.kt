package com.recall.voice.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.recall.voice.R
import com.recall.voice.api.Rating

// The enamel and its inks. Each line ink belongs to one rating and to nothing else.
private val Midnight = Color(0xFF0B1230)
private val MidnightRaised = Color(0xFF172052)
private val MidnightSeam = Color(0xFF34407A)
private val Porcelain = Color(0xFFF4F6FB)
private val PorcelainDim = Color(0xFFB9C1E8)
private val PorcelainRule = Color(0xFFC5CBE3)
private val InkMuted = Color(0xFF4A5385)
private val Scarlet = Color(0xFFE5322D)
private val Amber = Color(0xFFFFB000)
private val Green = Color(0xFF178F4B)
private val Cobalt = Color(0xFF2F6BFF)

/** Roles Material's scheme has no slot for: the constant midnight shell, the card panel and the line. */
@Immutable
data class RecallColors(
  val shell: Color,
  val onShell: Color,
  val onShellMuted: Color,
  val track: Color,
  val card: Color,
  /** Keyline around the card panel where its tone alone does not part it from the ground. */
  val cardEdge: Color,
  val onCard: Color,
  val onCardMuted: Color,
  val cardRule: Color,
  val cardCode: Color,
  val cardMark: Color,
  val again: Color,
  val hard: Color,
  val good: Color,
  val easy: Color,
) {
  fun ink(rating: Rating): Color = when (rating) {
    Rating.Again -> again
    Rating.Hard -> hard
    Rating.Good -> good
    Rating.Easy -> easy
  }

  /** Text colour that stays legible on [ink]. */
  fun onInk(rating: Rating): Color = if (rating == Rating.Hard) Color(0xFF0B1230) else Color.White
}

private val NightColors = RecallColors(
  shell = Midnight, onShell = Porcelain, onShellMuted = PorcelainDim, track = MidnightSeam,
  card = Porcelain, cardEdge = Color.Unspecified, onCard = Midnight, onCardMuted = InkMuted, cardRule = PorcelainRule,
  cardCode = Color(0xFFE3E8F6), cardMark = Color(0xFFFFE08A),
  again = Scarlet, hard = Amber, good = Green, easy = Cobalt,
)
private val DayColors = NightColors.copy(card = Color.White, cardEdge = PorcelainRule, cardCode = Color(0xFFEDF0F9))

val LocalRecallColors = staticCompositionLocalOf { NightColors }

private val NightScheme = darkColorScheme(
  primary = Porcelain, onPrimary = Midnight,
  primaryContainer = MidnightRaised, onPrimaryContainer = Porcelain,
  secondary = PorcelainDim, onSecondary = Midnight,
  secondaryContainer = MidnightRaised, onSecondaryContainer = Porcelain,
  tertiary = Amber, onTertiary = Midnight,
  background = Midnight, onBackground = Porcelain,
  surface = Midnight, onSurface = Porcelain,
  surfaceVariant = MidnightRaised, onSurfaceVariant = PorcelainDim,
  surfaceContainerLowest = Midnight, surfaceContainerLow = Color(0xFF111A40),
  surfaceContainer = MidnightRaised, surfaceContainerHigh = Color(0xFF1E2962),
  surfaceContainerHighest = Color(0xFF263272),
  outline = Color(0xFF7C88BD), outlineVariant = MidnightSeam,
  error = Color(0xFFFF8A80), onError = Midnight,
  errorContainer = Color(0xFF5A1512), onErrorContainer = Color(0xFFFFDAD6),
)

private val DayScheme = lightColorScheme(
  primary = Midnight, onPrimary = Porcelain,
  primaryContainer = Color(0xFFDCE2F5), onPrimaryContainer = Midnight,
  secondary = InkMuted, onSecondary = Color.White,
  secondaryContainer = Color(0xFFDCE2F5), onSecondaryContainer = Midnight,
  tertiary = Color(0xFF8A5A00), onTertiary = Color.White,
  background = Porcelain, onBackground = Midnight,
  surface = Porcelain, onSurface = Midnight,
  surfaceVariant = Color(0xFFE4E8F5), onSurfaceVariant = InkMuted,
  surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFEDF0F9),
  surfaceContainer = Color(0xFFE4E8F5), surfaceContainerHigh = Color(0xFFDCE2F5),
  surfaceContainerHighest = Color(0xFFD3DAF0),
  outline = Color(0xFF6B76A8), outlineVariant = PorcelainRule,
  error = Color(0xFFB3211C), onError = Color.White,
  errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
)

@OptIn(ExperimentalTextApi::class)
private fun encode(weight: Int, width: Float = 100f) = Font(
  R.font.encode_sans,
  weight = FontWeight(weight),
  variationSettings = FontVariation.Settings(FontVariation.weight(weight), FontVariation.width(width)),
)

val EncodeSans = FontFamily(encode(400), encode(500), encode(600), encode(700), encode(800))

/** Semi-condensed cut for tracked caps: column heads and section labels. */
val EncodeSansNarrow = FontFamily(encode(600, 87.5f), encode(700, 87.5f))

private fun style(size: Int, line: Int, weight: Int, tracking: Float = 0f) = TextStyle(
  fontFamily = EncodeSans, fontSize = size.sp, lineHeight = line.sp,
  fontWeight = FontWeight(weight), letterSpacing = tracking.em, fontFeatureSettings = "tnum",
)

private val RecallType = Typography(
  displaySmall = style(36, 42, 800, -0.01f),
  headlineLarge = style(30, 36, 800, -0.01f),
  headlineMedium = style(26, 32, 700, -0.005f),
  headlineSmall = style(24, 31, 700),
  titleLarge = style(22, 30, 700),
  titleMedium = style(18, 24, 600),
  titleSmall = style(15, 20, 600),
  bodyLarge = style(17, 25, 500),
  bodyMedium = style(15, 22, 500),
  bodySmall = style(13, 18, 500),
  labelLarge = style(16, 20, 700),
  labelMedium = style(14, 18, 600),
  labelSmall = TextStyle(
    fontFamily = EncodeSansNarrow, fontSize = 13.sp, lineHeight = 16.sp,
    fontWeight = FontWeight(700), letterSpacing = 0.08.em,
  ),
)

private val RecallShapes = Shapes(
  extraSmall = RoundedCornerShape(6.dp),
  small = RoundedCornerShape(10.dp),
  medium = RoundedCornerShape(14.dp),
  large = RoundedCornerShape(18.dp),
  extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun RecallTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
  CompositionLocalProvider(LocalRecallColors provides if (dark) NightColors else DayColors) {
    MaterialTheme(
      colorScheme = if (dark) NightScheme else DayScheme,
      typography = RecallType,
      shapes = RecallShapes,
      content = content,
    )
  }
}

object Recall {
  val colors: RecallColors
    @Composable get() = LocalRecallColors.current
}
