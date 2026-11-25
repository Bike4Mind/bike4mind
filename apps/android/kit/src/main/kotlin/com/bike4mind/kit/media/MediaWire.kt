package com.bike4mind.kit.media

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import java.time.Instant
import java.time.format.DateTimeParseException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Hand-written client for the Files routes the web app's generated-media views read: `GET /api/files` filtered to
 * generated files and `GET /api/files/{id}` (JWT bearer via [http]'s B4MTransport). Twin of apps/ios
 * B4MKit/Media/MediaWire.swift; neither route is in the public contract, and the public `GET /api/v1/files` has
 * no generated or type filter. Keep in sync with `searchFabFilesSchema`
 * (b4m-core/services/src/fabFileService/search.ts).
 */
class MediaWire(private val environment: ServerEnvironment, private val http: HttpClient) : MediaApi {
    override suspend fun list(kind: MediaKind?, page: Int, limit: Int): MediaPage {
        val response = http.get(environment.baseUrl + FILES_PATH) {
            listQuery(kind, page, limit).forEach { (name, value) -> parameter(name, value) }
        }
        val body = decode(response, WireList.serializer())
        // A row the gallery cannot draw (a document, a malformed record) is skipped, not fatal.
        return MediaPage(body.data.mapNotNull(WireFile::toItem), body.hasMore ?: false)
    }

    override suspend fun item(id: String): MediaItem {
        // The id may come from elsewhere one day; anything that is not a plain id never reaches the URL.
        if (!Route.isValidId(id)) throw ApiException(404)
        val response = http.get("${environment.baseUrl}$FILES_PATH/$id")
        return decode(response, WireFile.serializer()).toItem() ?: throw MalformedMediaException()
    }

    private suspend fun <T> decode(response: HttpResponse, serializer: KSerializer<T>): T {
        if (!response.status.isSuccess()) throw ApiException(response.status.value)
        return try {
            B4MClientJson.decodeFromString(serializer, response.bodyAsText())
        } catch (malformed: SerializationException) {
            throw MalformedMediaException(malformed)
        } catch (malformed: IllegalArgumentException) {
            throw MalformedMediaException(malformed)
        }
    }

    companion object {
        const val FILES_PATH = "/api/files"

        fun listQuery(kind: MediaKind?, page: Int, limit: Int): List<Pair<String, String>> = buildList {
            add("filters[generated]" to "true")
            kind?.let { add("filters[type]" to it.wire) }
            add("pagination[page]" to page.toString())
            add("pagination[limit]" to limit.toString())
            add("order[by]" to "createdAt")
            add("order[direction]" to "desc")
            // The gallery never needs extracted text, which can be megabytes per file.
            add("options[excludeContent]" to "true")
        }
    }
}

@Serializable
private data class WireList(val data: List<WireFile>, val hasMore: Boolean? = null)

@Serializable
private data class WireFile(
    val id: String? = null,
    @Suppress("PropertyName") val _id: String? = null,
    val fileName: String? = null,
    val mimeType: String? = null,
    val fileSize: Double? = null,
    val fileUrl: String? = null,
    val fileUrlExpireAt: String? = null,
    val createdAt: String? = null,
    // Read loosely: a provenance shape this build does not expect must not drop the whole page.
    val sourceMetadata: JsonElement? = null,
) {
    fun toItem(): MediaItem? {
        val id = id ?: _id ?: return null
        val mimeType = mimeType ?: return null
        val kind = MediaKind.fromMimeType(mimeType) ?: return null
        return MediaItem(
            id = id,
            kind = kind,
            fileName = fileName.orEmpty(),
            mimeType = mimeType,
            createdAt = instant(createdAt) ?: Instant.EPOCH,
            fileSize = fileSize?.toLong(),
            url = fileUrl?.takeIf { it.isNotEmpty() },
            urlExpiresAt = instant(fileUrlExpireAt),
            prompt = prompt(),
        )
    }

    // Older files carry an empty prompt, which reads as unknown.
    private fun prompt(): String? {
        val generation = (sourceMetadata as? JsonObject)?.get("generation") as? JsonObject ?: return null
        return (generation["prompt"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }
    }
}

private fun instant(raw: String?): Instant? = raw?.let {
    try {
        Instant.parse(it)
    } catch (unparseable: DateTimeParseException) {
        null
    }
}
