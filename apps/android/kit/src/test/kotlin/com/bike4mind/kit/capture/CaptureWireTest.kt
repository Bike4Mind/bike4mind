package com.bike4mind.kit.capture

import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import java.io.File
import java.time.Instant
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest

class CaptureWireTest {
    private val json = headersOf(HttpHeaders.ContentType, "application/json")
    private val environment = ServerEnvironment.Custom("https://staging.example.test")
    private val dir: File = createTempDirectory("capture-wire").toFile()

    @AfterTest
    fun cleanUp() {
        dir.deleteRecursively()
    }

    private fun wire(api: MockEngine, storage: MockEngine = MockEngine { respond("", HttpStatusCode.OK) }) =
        CaptureWire(environment, HttpClient(api), HttpClient(storage))

    @Test
    fun createUploadPostsSnakeCaseAndReadsTheTicket() = runTest {
        var body = ""
        var path = ""
        val engine = MockEngine { request ->
            path = request.url.encodedPath
            assertEquals(HttpMethod.Post, request.method)
            body = request.body.toByteArray().decodeToString()
            respond(
                """{"id":"f1","upload_url":"https://s3.example.test/u","upload_url_expires_at":"2026-11-23T10:00:00.000Z","extra":1}""",
                HttpStatusCode.Created,
                json,
            )
        }

        val ticket = wire(engine).createUpload("a.png", "image/png", 42)

        assertEquals("/api/v1/files", path)
        assertEquals("""{"file_name":"a.png","mime_type":"image/png","file_size":42}""", body)
        assertEquals(UploadTicket("f1", "https://s3.example.test/u", Instant.parse("2026-11-23T10:00:00Z")), ticket)
    }

    @Test
    fun aMissingExpiryIsNull() = runTest {
        val engine = MockEngine { respond("""{"id":"f1","upload_url":"https://s3.example.test/u"}""", HttpStatusCode.Created, json) }

        assertNull(wire(engine).createUpload("a", "image/png", 1).expiresAt)
    }

    @Test
    fun anUnprocessableUploadCarriesTheServersMessage() = runTest {
        val engine = MockEngine { respond("""{"error":"Too big"}""", HttpStatusCode.UnprocessableEntity, json) }

        val error = assertFailsWith<CaptureRejectedException> { wire(engine).createUpload("a", "image/png", 1) }

        assertEquals("Too big", error.message)
    }

    @Test
    fun aServerErrorIsAnApiException() = runTest {
        val engine = MockEngine { respond("", HttpStatusCode.InternalServerError) }

        assertEquals(500, assertFailsWith<ApiException> { wire(engine).createUpload("a", "image/png", 1) }.status)
    }

    @Test
    fun uploadPutsTheExactBytesWithoutCredentials() = runTest {
        val file = File(dir, "p.bin").apply { writeBytes(ByteArray(200_000) { (it % 251).toByte() }) }
        var method: HttpMethod? = null
        var url = ""
        var ifNoneMatch: String? = null
        var authorization: String? = "unset"
        var contentType: String? = null
        var sent = ByteArray(0)
        val storage = MockEngine { request ->
            method = request.method
            url = request.url.toString()
            ifNoneMatch = request.headers[HttpHeaders.IfNoneMatch]
            authorization = request.headers[HttpHeaders.Authorization]
            contentType = request.body.contentType?.toString()
            sent = request.body.toByteArray()
            respond("", HttpStatusCode.OK)
        }
        val api = MockEngine { error("the API client must not see the PUT") }

        wire(api, storage).upload(UploadTicket("f1", "https://s3.example.test/u?sig=1", null), file, "image/png")

        assertEquals(HttpMethod.Put, method)
        assertEquals("https://s3.example.test/u?sig=1", url)
        assertEquals("*", ifNoneMatch)
        assertNull(authorization)
        assertEquals("image/png", contentType)
        assertContentEquals(file.readBytes(), sent)
    }

    @Test
    fun aPreconditionFailedPutIsSuccess() = runTest {
        val file = File(dir, "p.bin").apply { writeBytes(byteArrayOf(1)) }
        val storage = MockEngine { respond("", HttpStatusCode.PreconditionFailed) }

        wire(MockEngine { error("unused") }, storage).upload(UploadTicket("f1", "https://s3.example.test/u", null), file, "image/png")
    }

    @Test
    fun aRefusedPutThrowsItsStatus() = runTest {
        val file = File(dir, "p.bin").apply { writeBytes(byteArrayOf(1)) }
        val storage = MockEngine { respond("", HttpStatusCode.Forbidden) }

        val error = assertFailsWith<UploadPutException> {
            wire(MockEngine { error("unused") }, storage).upload(UploadTicket("f1", "https://s3.example.test/u", null), file, "image/png")
        }

        assertEquals(403, error.status)
    }

    @Test
    fun fileStatusMapsTheModerationState() = runTest {
        val cases = mapOf(
            """{"id":"f"}""" to RemoteFileStatus.UNSCANNED,
            """{"moderation_status":null}""" to RemoteFileStatus.UNSCANNED,
            """{"moderation_status":"clean"}""" to RemoteFileStatus.CLEAN,
            """{"moderation_status":"blocked"}""" to RemoteFileStatus.BLOCKED,
            """{"moderation_status":"scanning"}""" to RemoteFileStatus.SCANNING,
            """{"moderation_status":"queued"}""" to RemoteFileStatus.PENDING,
        )
        for ((body, expected) in cases) {
            var path = ""
            val engine = MockEngine { request ->
                path = request.url.encodedPath
                respond(body, HttpStatusCode.OK, json)
            }

            assertEquals(expected, wire(engine).fileStatus("f9"), body)
            assertEquals("/api/v1/files/f9", path)
        }
    }

    private fun questPage(prompts: List<String>, next: String?, firstId: Int = 1): String {
        val data = prompts.mapIndexed { i, p -> """{"id":"q${firstId + i}","prompt":"$p"}""" }.joinToString(",")
        val cursor = next?.let { ""","next_cursor":"$it"""" }.orEmpty()
        return """{"data":[$data]$cursor}"""
    }

    @Test
    fun findSentTurnMatchesATrimmedPrompt() = runTest {
        val engine = MockEngine { request ->
            assertEquals("/api/v1/sessions/s1/quests", request.url.encodedPath)
            assertEquals("100", request.url.parameters["limit"])
            respond(questPage(listOf("other", "  hello there  "), null), HttpStatusCode.OK, json)
        }

        assertEquals(SentTurnLookup.Found("q2"), wire(engine).findSentTurn("s1", " hello there\n"))
    }

    @Test
    fun findSentTurnFollowsTheCursor() = runTest {
        val cursors = mutableListOf<String?>()
        val engine = MockEngine { request ->
            val cursor = request.url.parameters["cursor"]
            cursors += cursor
            if (cursor == null) {
                respond(questPage(listOf("a"), "c2"), HttpStatusCode.OK, json)
            } else {
                respond(questPage(listOf("wanted"), null, firstId = 7), HttpStatusCode.OK, json)
            }
        }

        assertEquals(SentTurnLookup.Found("q7"), wire(engine).findSentTurn("s1", "wanted"))
        assertEquals(listOf(null, "c2"), cursors)
    }

    @Test
    fun findSentTurnIsNotFoundWhenTheLastPageEnds() = runTest {
        val engine = MockEngine { respond(questPage(listOf("a"), null), HttpStatusCode.OK, json) }

        assertEquals(SentTurnLookup.NotFound, wire(engine).findSentTurn("s1", "wanted"))
    }

    @Test
    fun findSentTurnIsInconclusiveAfterTheMaximumPages() = runTest {
        var pages = 0
        val engine = MockEngine {
            pages++
            respond(questPage(listOf("a"), "more"), HttpStatusCode.OK, json)
        }

        assertEquals(SentTurnLookup.Inconclusive, wire(engine).findSentTurn("s1", "wanted"))
        assertEquals(CaptureWire.MAX_RECONCILE_PAGES, pages)
    }
}
