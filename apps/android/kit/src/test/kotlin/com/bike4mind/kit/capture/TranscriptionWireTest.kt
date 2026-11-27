package com.bike4mind.kit.capture

import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class TranscriptionWireTest {
    private val json = headersOf(HttpHeaders.ContentType, "application/json")
    private val environment = ServerEnvironment.Custom("https://staging.example.test")
    private val dir: File = createTempDirectory("transcription-wire").toFile()

    @AfterTest
    fun cleanUp() {
        dir.deleteRecursively()
    }

    private fun audio(bytes: ByteArray = "voice".toByteArray()) = File(dir, "note.m4a").apply { writeBytes(bytes) }

    private val mintReply = """{"upload_url":"https://s3.example.test/bucket","upload_fields":{"key":"k/1","policy":"p","Content-Type":"audio/mp4"},"file_key":"k/1"}"""

    private fun wire(api: MockEngine, storage: MockEngine = MockEngine { respond("", HttpStatusCode.NoContent) }) =
        TranscriptionWire(environment, HttpClient(api), HttpClient(storage))

    @Test
    fun mintsUploadsThenTranscribes() = runTest {
        val paths = mutableListOf<String>()
        var transcribeBody = ""
        var mintBody = ""
        val api = MockEngine { request ->
            paths += request.url.encodedPath
            val body = request.body.toByteArray().decodeToString()
            if (request.url.encodedPath.endsWith("/uploads")) {
                mintBody = body
                respond(mintReply, HttpStatusCode.Created, json)
            } else {
                transcribeBody = body
                respond("""{"text":"  hello  "}""", HttpStatusCode.OK, json)
            }
        }
        var storageUrl = ""
        var multipart = ""
        val storage = MockEngine { request ->
            storageUrl = request.url.toString()
            multipart = request.body.toByteArray().decodeToString()
            respond("", HttpStatusCode.NoContent)
        }

        val text = wire(api, storage).transcribe(audio(), "audio/mp4")

        assertEquals("hello", text)
        assertEquals(listOf("/api/v1/transcriptions/uploads", "/api/v1/transcriptions"), paths)
        assertEquals("""{"mime_type":"audio/mp4","file_size":5}""", mintBody)
        assertEquals("""{"file_key":"k/1"}""", transcribeBody)
        assertEquals("https://s3.example.test/bucket", storageUrl)
        val file = multipart.indexOf("name=\"file\"")
        assertTrue(file > 0, multipart)
        for (field in listOf("name=\"key\"", "name=\"policy\"", "name=\"Content-Type\"")) {
            val at = multipart.indexOf(field)
            assertTrue(at in 0 until file, "$field must precede the file part: $multipart")
        }
        assertTrue(multipart.contains("voice"))
    }

    @Test
    fun insufficientCreditsIsDistinguished() = runTest {
        val api = MockEngine { respond("""{"error":"x","errorCode":"insufficient_credits"}""", HttpStatusCode.UnprocessableEntity, json) }

        assertFailsWith<TranscriptionException.InsufficientCredits> { wire(api).transcribe(audio(), "audio/mp4") }
    }

    @Test
    fun anyOtherUnprocessableIsAnUnusableRecording() = runTest {
        val api = MockEngine { respond("""{"error":"bad audio"}""", HttpStatusCode.UnprocessableEntity, json) }

        assertFailsWith<TranscriptionException.UnusableRecording> { wire(api).transcribe(audio(), "audio/mp4") }
    }

    @Test
    fun noSpeechModelIsUnavailable() = runTest {
        val api = MockEngine { respond("", HttpStatusCode.ServiceUnavailable) }

        assertFailsWith<TranscriptionException.Unavailable> { wire(api).transcribe(audio(), "audio/mp4") }
    }

    @Test
    fun otherStatusesAreApiExceptions() = runTest {
        val api = MockEngine { respond("", HttpStatusCode.InternalServerError) }

        assertEquals(500, assertFailsWith<ApiException> { wire(api).transcribe(audio(), "audio/mp4") }.status)
    }

    @Test
    fun aRefusedStoragePostFails() = runTest {
        val api = MockEngine { respond(mintReply, HttpStatusCode.Created, json) }
        val storage = MockEngine { respond("", HttpStatusCode.Forbidden) }

        assertFailsWith<TranscriptionException.Failed> { wire(api, storage).transcribe(audio(), "audio/mp4") }
    }

    @Test
    fun anEmptyRecordingNeverReachesTheNetwork() = runTest {
        val api = MockEngine { error("no request expected") }
        val storage = MockEngine { error("no request expected") }

        assertFailsWith<TranscriptionException.UnusableRecording> { wire(api, storage).transcribe(audio(ByteArray(0)), "audio/mp4") }
        assertTrue(api.requestHistory.isEmpty() && storage.requestHistory.isEmpty())
    }
}
