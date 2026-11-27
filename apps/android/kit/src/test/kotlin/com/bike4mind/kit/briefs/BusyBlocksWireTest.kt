package com.bike4mind.kit.briefs

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class BusyBlocksWireTest {
    private val environment = ServerEnvironment.Custom("https://staging.example.test")
    private val sent = mutableListOf<Triple<HttpMethod, String, String>>()

    private fun wire(status: HttpStatusCode = HttpStatusCode.OK, body: String = STATE) =
        BusyBlocksWire(
            environment,
            HttpClient(
                MockEngine { request ->
                    sent += Triple(request.method, request.url.encodedPath, (request.body as? TextContent)?.text.orEmpty())
                    respond(body, status)
                },
            ),
        )

    @Test
    fun stateDecodesBlocksAndTheNextBriefTime() = runTest {
        val state = wire().state()

        assertEquals(HttpMethod.Get to "/api/v1/briefs/busy-blocks", sent.single().let { it.first to it.second })
        assertEquals(true, state.enabled)
        assertEquals(
            listOf(BusyBlock(Instant.parse("2026-11-25T15:00:00Z"), Instant.parse("2026-11-25T16:00:00Z"))),
            state.blocks,
        )
        assertEquals(Instant.parse("2026-11-25T16:00:00Z"), state.nextBlockBriefAt)
    }

    @Test
    fun aNullNextBriefTimeDecodes() = runTest {
        val state = wire(body = """{"enabled":false,"blocks":[],"nextBlockBriefAt":null}""").state()

        assertEquals(false, state.enabled)
        assertNull(state.nextBlockBriefAt)
    }

    @Test
    fun saveSendsOnlyTheOptInAndBlockTimes() = runTest {
        val block = BusyBlock(Instant.parse("2026-11-25T15:00:00Z"), Instant.parse("2026-11-25T16:30:00.250Z"))
        wire().save(enabled = true, blocks = listOf(block))

        val (method, path, text) = sent.single()
        assertEquals(HttpMethod.Put, method)
        assertEquals("/api/v1/briefs/busy-blocks", path)
        val json = B4MClientJson.parseToJsonElement(text).jsonObject
        assertEquals(setOf("enabled", "blocks"), json.keys)
        val sentBlock = json.getValue("blocks").jsonArray.single() as JsonObject
        assertEquals(setOf("start", "end"), sentBlock.keys)
        assertEquals(block.start, Instant.parse(sentBlock.getValue("start").jsonPrimitive.content))
        assertEquals(block.end, Instant.parse(sentBlock.getValue("end").jsonPrimitive.content))
    }

    @Test
    fun aNonSuccessStatusIsAnApiException() = runTest {
        assertEquals(401, assertFailsWith<ApiException> { wire(HttpStatusCode.Unauthorized, "{}").state() }.status)
        assertEquals(500, assertFailsWith<ApiException> { wire(HttpStatusCode.InternalServerError, "{}").save(false, emptyList()) }.status)
    }

    @Test
    fun aMalformedSuccessBodyIsRejected() = runTest {
        assertFailsWith<MalformedBusyBlocksException> { wire(body = "not json").state() }
        assertFailsWith<MalformedBusyBlocksException> { wire(body = """{"enabled":true}""").state() }
        assertFailsWith<MalformedBusyBlocksException> {
            wire(body = """{"enabled":true,"blocks":[{"start":"yesterday","end":"today"}]}""").state()
        }
    }

    private companion object {
        const val STATE =
            """{"enabled":true,"blocks":[{"start":"2026-11-25T15:00:00.000Z","end":"2026-11-25T16:00:00Z"}],"nextBlockBriefAt":"2026-11-25T16:00:00.000Z"}"""
    }
}
