package com.recall.voice.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.recall.voice.api.Rating
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

data class AppConfig(
  val baseUrl: String = "",
  val token: String = "",
  val locale: String = "es-ES",
  val defaultRatingOnTimeout: Rating = Rating.Again,
  /** Use the server's cloud TTS endpoint instead of on-device TTS. */
  val useRemoteTts: Boolean = true,
)

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "recall-voice")

private val KEY_BASE_URL = stringPreferencesKey("baseUrl")
private val KEY_TOKEN = stringPreferencesKey("token")
private val KEY_LOCALE = stringPreferencesKey("locale")
private val KEY_DEFAULT_RATING = stringPreferencesKey("defaultRating")
private val KEY_USE_REMOTE_TTS = androidx.datastore.preferences.core.booleanPreferencesKey("useRemoteTts")

class AppSettings(private val context: Context) {

  val config: Flow<AppConfig> = context.dataStore.data.map { prefs ->
    AppConfig(
      baseUrl = prefs[KEY_BASE_URL] ?: "",
      token = prefs[KEY_TOKEN] ?: "",
      locale = prefs[KEY_LOCALE] ?: "es-ES",
      defaultRatingOnTimeout = runCatching {
        Rating.valueOf(prefs[KEY_DEFAULT_RATING] ?: Rating.Again.name)
      }.getOrDefault(Rating.Again),
      useRemoteTts = prefs[KEY_USE_REMOTE_TTS] ?: true,
    )
  }

  suspend fun update(transform: (AppConfig) -> AppConfig) {
    context.dataStore.edit { prefs ->
      val current = AppConfig(
        baseUrl = prefs[KEY_BASE_URL] ?: "",
        token = prefs[KEY_TOKEN] ?: "",
        locale = prefs[KEY_LOCALE] ?: "es-ES",
        defaultRatingOnTimeout = runCatching {
          Rating.valueOf(prefs[KEY_DEFAULT_RATING] ?: Rating.Again.name)
        }.getOrDefault(Rating.Again),
        useRemoteTts = prefs[KEY_USE_REMOTE_TTS] ?: true,
      )
      val next = transform(current)
      prefs[KEY_BASE_URL] = next.baseUrl
      prefs[KEY_TOKEN] = next.token
      prefs[KEY_LOCALE] = next.locale
      prefs[KEY_DEFAULT_RATING] = next.defaultRatingOnTimeout.name
      prefs[KEY_USE_REMOTE_TTS] = next.useRemoteTts
    }
  }
}
