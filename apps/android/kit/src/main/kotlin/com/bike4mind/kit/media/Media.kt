package com.bike4mind.kit.media

import com.bike4mind.kit.networking.ApiException
import java.time.Duration
import java.time.Instant

/** What the gallery can show. Twin of apps/ios B4MKit/Media/MediaItem.swift. */
enum class MediaKind(val wire: String) {
    IMAGE("image"), VIDEO("video"), AUDIO("audio");

    companion object {
        /** Null for anything the gallery cannot show (documents). */
        fun fromMimeType(mimeType: String): MediaKind? {
            val prefix = mimeType.lowercase().substringBefore('/')
            return entries.firstOrNull { it.wire == prefix }
        }

        fun fromWire(wire: String): MediaKind? = entries.firstOrNull { it.wire == wire }
    }
}

/** One generated file as the gallery shows it. */
data class MediaItem(
    val id: String,
    val kind: MediaKind,
    val fileName: String,
    val mimeType: String,
    val createdAt: Instant,
    val fileSize: Long? = null,
    /** A presigned storage URL. Short-lived: see [isUrlUsable]. */
    val url: String? = null,
    val urlExpiresAt: Instant? = null,
    /** The prompt that made it, when the server recorded one. */
    val prompt: String? = null,
) {
    /** Whether [url] can be handed to a loader at [now]. A URL with no known expiry is trusted until it fails. */
    fun isUrlUsable(now: Instant): Boolean {
        if (url == null) return false
        val expiresAt = urlExpiresAt ?: return true
        return Duration.between(now, expiresAt) > EXPIRY_MARGIN
    }

    /** The file name without its extension; null when there is none, so the screen can name the kind instead. */
    val displayTitle: String?
        get() = fileName.substringBeforeLast('.').takeIf { it.isNotEmpty() }

    companion object {
        /** Presigned URLs are refetched this long before they lapse, so a player never starts on a dying URL. */
        val EXPIRY_MARGIN: Duration = Duration.ofSeconds(60)
    }
}

data class MediaPage(val items: List<MediaItem>, val hasMore: Boolean)

/** What the gallery asks of the backend; [MediaWire] is the live one. */
interface MediaApi {
    /** Generated media, newest first. [page] is 1-based; a null [kind] lists every kind. */
    suspend fun list(kind: MediaKind?, page: Int, limit: Int): MediaPage

    /** One item with a freshly signed URL. */
    suspend fun item(id: String): MediaItem
}

/** A 2xx answer whose body is not a media list or file. */
class MalformedMediaException(cause: Throwable? = null) : Exception("The server sent media this build cannot read", cause)

/** Why a load failed, for the screen to word; kept apart from strings so :kit stays resource-free. */
sealed interface MediaError {
    data object Offline : MediaError
    data object NotFound : MediaError
    data object RateLimited : MediaError
    data object Unreadable : MediaError
    /** The file's URL could not be played even after fresh ones were fetched. */
    data object Unplayable : MediaError
    data class Server(val status: Int) : MediaError

    /** Worth offering "Try again" for. */
    val isRetryable: Boolean
        get() = this != NotFound && this != Unreadable

    companion object {
        fun from(failure: Exception): MediaError = when (failure) {
            is ApiException -> when (failure.status) {
                404 -> NotFound
                429 -> RateLimited
                else -> Server(failure.status)
            }
            is MalformedMediaException -> Unreadable
            else -> Offline
        }
    }
}
