package com.bike4mind.kit.artifacts

import com.bike4mind.client.apis.ArtifactsApi
import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.B4MTransport
import com.bike4mind.kit.networking.ClientIdentity
import com.bike4mind.kit.networking.ClientUpgradeSignal
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.headersOf
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest

class ArtifactsRepositoryTest {
    private val transport = B4MTransport(ClientIdentity.android("1.0"), ClientUpgradeSignal(), tokens = null)

    private fun repository(status: HttpStatusCode = HttpStatusCode.OK, body: String, onRequest: (Url) -> Unit = {}) =
        ArtifactsRepository(
            ArtifactsApi(
                "https://staging.example.test",
                MockEngine { request ->
                    onRequest(request.url)
                    respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
                },
            ) { transport.install(it) },
        )

    @Test
    fun listsOneCursorPageAndMapsEveryRow() = runTest {
        var url: Url? = null
        val page = repository(body = LIST) { url = it }.list(cursor = "abc", limit = 10)

        assertEquals("/api/v1/artifacts", url!!.encodedPath)
        assertEquals("abc", url!!.parameters["cursor"])
        assertEquals("10", url!!.parameters["limit"])
        assertEquals("next-1", page.nextCursor)
        assertEquals(listOf("a1", "a2"), page.items.map { it.id })
        val first = page.items.first()
        assertEquals(ArtifactType.HTML, first.type)
        assertEquals("Landing page", first.title)
        assertEquals(3, first.version)
        assertEquals(Instant.parse("2026-11-20T10:00:00.000Z"), first.updatedAt)
        // A type this build does not know, and a blank title, still make a row.
        assertEquals(ArtifactType.UNKNOWN, page.items[1].type)
        assertEquals("Untitled", page.items[1].title)
    }

    @Test
    fun theLastPageHasNoCursor() = runTest {
        assertNull(repository(body = """{"data":[],"next_cursor":null}""").list(null).nextCursor)
    }

    @Test
    fun getsOneArtifactWithItsContent() = runTest {
        var url: Url? = null
        val detail = repository(body = ONE) { url = it }.get("a1")

        assertEquals("/api/v1/artifacts/a1", url!!.encodedPath)
        assertEquals("<h1>Hi</h1>", detail.content)
        assertEquals("a1", detail.summary.id)
    }

    @Test
    fun anIdThatIsNotPlainNeverReachesTheUrl() = runTest {
        var called = false
        val repository = repository(body = ONE) { called = true }
        assertEquals(404, assertFailsWith<ApiException> { repository.get("../../admin") }.status)
        assertEquals(false, called)
    }

    @Test
    fun aNon2xxAnswerIsAnApiException() = runTest {
        val failure = assertFailsWith<ApiException> { repository(HttpStatusCode.NotFound, """{"error":"nope"}""").get("a1") }
        assertEquals(404, failure.status)
    }

    private companion object {
        fun row(id: String, type: String, title: String, content: String = "null") =
            """{"id":"$id","type":"$type","title":"$title","description":null,"version":3,"version_tag":null,"status":"active","tags":[],""" +
                """"session_id":null,"project_id":null,"visibility":"private","created_at":"2026-11-19T10:00:00.000Z",""" +
                """"updated_at":"2026-11-20T10:00:00.000Z","content":$content}"""

        val LIST = """{"data":[${row("a1", "html", "Landing page")},${row("a2", "hologram", " ")}],"next_cursor":"next-1"}"""
        val ONE = row("a1", "html", "Landing page", "\"<h1>Hi</h1>\"")
    }
}
