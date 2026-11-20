package com.bike4mind.kit.push

import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.test.runTest

class PushTokenWireTest {
    private val environment = ServerEnvironment.Custom("https://staging.example.test")

    @Test
    fun registerPostsAnAndroidDeviceTokenWithTheFixedFields() = runTest {
        var method: HttpMethod? = null
        var body = ""
        val engine = MockEngine { request ->
            assertEquals("/api/v1/push-tokens", request.url.encodedPath)
            method = request.method
            body = request.body.toByteArray().decodeToString()
            respond("", HttpStatusCode.NoContent)
        }

        PushTokenWire(environment, HttpClient(engine)).register("fcm-token", appVersion = "0.1.0")

        assertEquals(HttpMethod.Post, method)
        assertEquals(
            """{"token":"fcm-token","kind":"device","platform":"android","environment":"production","appVersion":"0.1.0"}""",
            body,
        )
    }

    @Test
    fun registerOmitsAnAbsentAppVersion() = runTest {
        var body = ""
        val engine = MockEngine { request ->
            body = request.body.toByteArray().decodeToString()
            respond("", HttpStatusCode.NoContent)
        }

        PushTokenWire(environment, HttpClient(engine)).register("fcm-token", appVersion = null)

        assertEquals("""{"token":"fcm-token","kind":"device","platform":"android","environment":"production"}""", body)
    }

    @Test
    fun unregisterDeletesWithTheTokenInTheBody() = runTest {
        var method: HttpMethod? = null
        var body = ""
        val engine = MockEngine { request ->
            method = request.method
            body = request.body.toByteArray().decodeToString()
            respond("", HttpStatusCode.NoContent)
        }

        PushTokenWire(environment, HttpClient(engine)).unregister("fcm-token")

        assertEquals(HttpMethod.Delete, method)
        assertEquals("""{"token":"fcm-token"}""", body)
    }

    @Test
    fun aNon2xxAnswerIsAnApiException() = runTest {
        val engine = MockEngine { respond("", HttpStatusCode.TooManyRequests) }

        val failure = assertFailsWith<ApiException> {
            PushTokenWire(environment, HttpClient(engine)).register("fcm-token", appVersion = null)
        }
        assertEquals(429, failure.status)
    }
}
