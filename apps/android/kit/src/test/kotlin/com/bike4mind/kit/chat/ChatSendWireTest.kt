package com.bike4mind.kit.chat

import com.bike4mind.kit.environment.ServerEnvironment
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest

class ChatSendWireTest {
    private val json = headersOf(HttpHeaders.ContentType, "application/json")
    private val environment = ServerEnvironment.Custom("https://staging.example.test")

    @Test
    fun aNewConversationOmitsTheSessionAndReadsTheQuestFromTrackingInfo() = runTest {
        var body = ""
        val engine = MockEngine { request ->
            assertEquals("/api/chat", request.url.encodedPath)
            body = request.body.toByteArray().decodeToString()
            respond("""{"status":"queued","sessionId":"s9","tracking_info":{"quest_id":"q9"},"extra":1}""", HttpStatusCode.OK, json)
        }

        val receipt = ChatSendWire(environment, HttpClient(engine)).send("Hi", sessionId = null)

        assertEquals("""{"message":"Hi","newConversation":true,"stream":true}""", body)
        assertEquals(ChatReceipt.Accepted("q9", "s9"), receipt)
    }

    @Test
    fun anErrorTypeIsARefusal() = runTest {
        val engine = MockEngine {
            respond("""{"type":"error","errorCode":"spend_cap_exceeded","message":"Cap reached"}""", HttpStatusCode.OK, json)
        }

        val receipt = ChatSendWire(environment, HttpClient(engine)).send("Hi", sessionId = "s1")

        assertEquals(ChatReceipt.Refused("spend_cap_exceeded", "Cap reached"), receipt)
    }
}
