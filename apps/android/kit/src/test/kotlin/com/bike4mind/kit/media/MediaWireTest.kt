package com.bike4mind.kit.media

import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class MediaWireTest {
    private val environment = ServerEnvironment.Custom("https://staging.example.test")

    private fun wire(status: HttpStatusCode = HttpStatusCode.OK, body: String, onRequest: (Url) -> Unit = {}) =
        MediaWire(
            environment,
            HttpClient(
                MockEngine { request ->
                    onRequest(request.url)
                    respond(body, status)
                },
            ),
        )

    @Test
    fun listsGeneratedFilesOfOneKindNewestFirst() = runTest {
        var url: Url? = null
        val page = wire(body = LIST) { url = it }.list(MediaKind.VIDEO, page = 2, limit = 30)

        val requested = url!!
        assertEquals("/api/files", requested.encodedPath)
        assertEquals("true", requested.parameters["filters[generated]"])
        assertEquals("video", requested.parameters["filters[type]"])
        assertEquals("2", requested.parameters["pagination[page]"])
        assertEquals("30", requested.parameters["pagination[limit]"])
        assertEquals("createdAt", requested.parameters["order[by]"])
        assertEquals("desc", requested.parameters["order[direction]"])
        assertEquals("true", requested.parameters["options[excludeContent]"])
        assertTrue(page.hasMore)
        assertEquals(listOf("img1", "vid1", "aud1"), page.items.map { it.id })
    }

    @Test
    fun allKindsSendsNoTypeFilter() = runTest {
        var url: Url? = null
        wire(body = LIST) { url = it }.list(null, page = 1, limit = 30)
        assertNull(url!!.parameters["filters[type]"])
    }

    @Test
    fun mapsAFileAndSkipsRowsTheGalleryCannotDraw() = runTest {
        val items = wire(body = LIST).list(null, 1, 30).items

        val image = items.first()
        assertEquals(MediaKind.IMAGE, image.kind)
        assertEquals("sunset.png", image.fileName)
        assertEquals("sunset", image.displayTitle)
        assertEquals(Instant.parse("2026-11-20T10:00:00.000Z"), image.createdAt)
        assertEquals(Instant.parse("2026-11-20T11:00:00.000Z"), image.urlExpiresAt)
        assertEquals("https://files.example.test/img1.png?sig=1", image.url)
        assertEquals(2048L, image.fileSize)
        assertEquals("A sunset over the sea", image.prompt)
        // The `_id` spelling, an unexpected provenance shape and an empty prompt all still read.
        val video = items[1]
        assertEquals(MediaKind.VIDEO, video.kind)
        assertNull(video.prompt)
        assertNull(video.urlExpiresAt)
    }

    @Test
    fun aMissingHasMoreMeansTheLastPage() = runTest {
        assertFalse(wire(body = """{"data":[]}""").list(null, 1, 30).hasMore)
    }

    @Test
    fun readsOneItem() = runTest {
        var path = ""
        val item = wire(body = IMAGE) { path = it.encodedPath }.item("img1")
        assertEquals("/api/files/img1", path)
        assertEquals("img1", item.id)
    }

    @Test
    fun aDocumentAsAnItemIsMalformed() = runTest {
        assertFailsWith<MalformedMediaException> {
            wire(body = """{"id":"d1","mimeType":"application/pdf"}""").item("d1")
        }
    }

    @Test
    fun aBodyThatIsNotAListIsMalformed() = runTest {
        assertFailsWith<MalformedMediaException> { wire(body = """{"data":"nope"}""").list(null, 1, 30) }
    }

    @Test
    fun aFailedStatusIsAnApiException() = runTest {
        val failure = assertFailsWith<ApiException> { wire(HttpStatusCode.NotFound, "{}").item("img1") }
        assertEquals(404, failure.status)
        assertEquals(MediaError.NotFound, MediaError.from(failure))
    }

    @Test
    fun aMalformedIdNeverReachesTheServer() = runTest {
        var called = false
        val wire = wire(body = IMAGE) { called = true }
        for (id in listOf("", "../me", "a/b", "x".repeat(65))) {
            assertFailsWith<ApiException> { wire.item(id) }
        }
        assertFalse(called)
    }

    private companion object {
        const val IMAGE = """{"id":"img1","fileName":"sunset.png","mimeType":"image/png","fileSize":2048,"fileUrl":"https://files.example.test/img1.png?sig=1","fileUrlExpireAt":"2026-11-20T11:00:00.000Z","createdAt":"2026-11-20T10:00:00.000Z","sourceMetadata":{"sessionId":"s1","generation":{"prompt":"A sunset over the sea"}},"content":null}"""
        const val LIST = """{"data":[$IMAGE,
            {"_id":"vid1","fileName":"clip.mp4","mimeType":"video/mp4","createdAt":"2026-11-19T10:00:00Z","sourceMetadata":{"generation":{"prompt":""}}},
            {"id":"doc1","fileName":"notes.pdf","mimeType":"application/pdf"},
            {"id":"aud0","fileName":"x.mp3"},
            {"id":"aud1","mimeType":"audio/mpeg","sourceMetadata":"unexpected"}
        ],"hasMore":true,"total":4}"""
    }
}
