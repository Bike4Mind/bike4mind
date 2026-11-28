package com.bike4mind.kit.auth

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Rewrites undated pending revocations once before the existing age limit can inspect them. */
object PendingRevocationCodec {
    @Serializable
    private data class Stored(val baseUrl: String, val refreshToken: String, val createdAt: Long? = null)

    private val json = Json { ignoreUnknownKeys = true }

    fun load(
        encoded: String?,
        nowMillis: Long,
        persist: (String) -> Unit,
        confirmPersisted: () -> Unit,
    ): List<PendingRevocation> {
        if (encoded == null) {
            confirmPersisted()
            return emptyList()
        }
        val content = encoded
        val stored = json.decodeFromString<List<Stored>>(content)
            .filter { it.baseUrl.isNotEmpty() && it.refreshToken.isNotEmpty() }
        val values = stored.map { PendingRevocation(it.baseUrl, it.refreshToken, it.createdAt ?: nowMillis) }
        if (stored.any { it.createdAt == null }) {
            persist(json.encodeToString(values.map { Stored(it.baseUrl, it.refreshToken, it.createdAtMillis) }))
        }
        confirmPersisted()
        return values
    }
}
