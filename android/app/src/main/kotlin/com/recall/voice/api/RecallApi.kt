package com.recall.voice.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.concurrent.TimeUnit

enum class AudioSide(val pathSegment: String) {
  Question("question"),
  Answer("answer"),
}

class ApiException(val code: Int, val responseBody: String) :
  Exception("HTTP $code: ${responseBody.take(200)}")

class RecallApi(
  baseUrl: String,
  private val token: String,
) {
  private val baseUrl: String = normalizeBaseUrl(baseUrl)

  private val client: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(5, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .callTimeout(45, TimeUnit.SECONDS)
    .build()

  private val json = apiJson
  private val mediaJson = "application/json; charset=utf-8".toMediaType()

  suspend fun health(): Boolean = healthChecked() == null

  /** Like [health] but returns the failure reason instead of a boolean. */
  suspend fun healthChecked(): String? = withContext(Dispatchers.IO) {
    runCatching {
      val req = Request.Builder().url(url("/health")).build()
      client.newCall(req).execute().use { resp ->
        if (resp.isSuccessful) null else "HTTP ${resp.code}"
      }
    }.getOrElse { e -> e.message ?: e::class.java.simpleName }
  }

  suspend fun getDecks(): List<DeckTreeNode> = withContext(Dispatchers.IO) {
    val text = getText("/decks")
    json.decodeFromString<DecksResponse>(text).decks
  }

  suspend fun getDue(deckId: String? = null, limit: Int = 20): List<DueItem> =
    withContext(Dispatchers.IO) {
      val q = buildList {
        if (!deckId.isNullOrBlank()) add("deckId=$deckId")
        add("limit=$limit")
      }.joinToString("&")
      val text = getText("/due?$q")
      json.decodeFromString<DueResponse>(text).items
    }

  /**
   * Posts [reviews]. With [due], the server also answers with the queue after the batch
   * ([ReviewResult.due]); an older server ignores it and the field stays null.
   */
  suspend fun postReviews(reviews: List<ReviewSubmit>, due: DueRequest? = null): ReviewResult =
    withContext(Dispatchers.IO) {
      val body = reviewsRequestBody(reviews, due).toRequestBody(mediaJson)
      val req = Request.Builder()
        .url(url("/reviews"))
        .post(body)
        .header("Authorization", "Bearer $token")
        .build()
      client.newCall(req).execute().use { resp ->
        val text = resp.body?.string().orEmpty()
        if (!resp.isSuccessful) throw ApiException(resp.code, text)
        decodeReviewResult(text)
      }
    }

  /**
   * Download the cloud-synthesized audio for [studyItemId]/[side] to [destFile].
   * Returns true on success; false on any HTTP / network failure (caller falls
   * back to local TTS in that case).
   */
  suspend fun downloadAudio(studyItemId: String, side: AudioSide, destFile: File): Boolean =
    withContext(Dispatchers.IO) {
      runCatching {
        val req = Request.Builder()
          .url(url("/audio/$studyItemId/${side.pathSegment}"))
          .header("Authorization", "Bearer $token")
          .build()
        client.newCall(req).execute().use { resp ->
          if (!resp.isSuccessful) return@withContext false
          val source = resp.body?.byteStream() ?: return@withContext false
          destFile.outputStream().use { out -> source.copyTo(out) }
          true
        }
      }.getOrDefault(false)
    }

  private fun url(path: String): String = "$baseUrl/api/v1$path"

  private fun getText(path: String): String {
    val req = Request.Builder()
      .url(url(path))
      .header("Authorization", "Bearer $token")
      .build()
    client.newCall(req).execute().use { resp ->
      val text = resp.body?.string().orEmpty()
      if (!resp.isSuccessful) throw ApiException(resp.code, text)
      return text
    }
  }
}

/** Defaults (and so a null `deckId` or an absent `due`) are not encoded. */
internal val apiJson = Json { ignoreUnknownKeys = true }

/** The exact `POST /reviews` body. */
internal fun reviewsRequestBody(reviews: List<ReviewSubmit>, due: DueRequest? = null): String =
  apiJson.encodeToString(ReviewsRequest(reviews, due))

internal fun decodeReviewResult(text: String): ReviewResult = apiJson.decodeFromString(text)

private fun normalizeBaseUrl(raw: String): String {
  val trimmed = raw.trim().trimEnd('/')
  if (trimmed.isEmpty()) return ""
  return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed
  else "http://$trimmed"
}
