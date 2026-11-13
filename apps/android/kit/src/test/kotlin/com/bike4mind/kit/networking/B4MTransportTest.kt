package com.bike4mind.kit.networking

import com.bike4mind.client.apis.AccountApi
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest

class B4MTransportTest {
    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    @Test
    fun stampsIdentityAndBearerOnGeneratedCalls() = runTest {
        var seen: Map<String, String?> = emptyMap()
        val engine = MockEngine { request ->
            seen = listOf("X-Client-Name", "X-Client-Version", "Authorization").associateWith { request.headers[it] }
            respond("""{"balance": 1}""", HttpStatusCode.OK, json)
        }
        val transport = B4MTransport(ClientIdentity.android("1.4"), ClientUpgradeSignal(), FixedTokens("token-1"))

        AccountApi("https://app.example.test", engine) { transport.install(it) }.getCreditBalance()

        assertEquals(
            mapOf("X-Client-Name" to "b4m-android", "X-Client-Version" to "1.4.0", "Authorization" to "Bearer token-1"),
            seen,
        )
    }

    @Test
    fun omitsAuthorizationWhenSignedOut() = runTest {
        var authorization: String? = "unset"
        val engine = MockEngine { request ->
            authorization = request.headers[HttpHeaders.Authorization]
            respond("""{"balance": 1}""", HttpStatusCode.OK, json)
        }
        val transport = B4MTransport(ClientIdentity.android("1.4"), ClientUpgradeSignal(), null)

        AccountApi("https://app.example.test", engine) { transport.install(it) }.getCreditBalance()

        assertNull(authorization)
    }

    @Test
    fun a426ReportsTheUpgradeAndFailsTheCall() = runTest {
        val engine = MockEngine {
            respond(
                """{"error":"Upgrade required","errorCode":"upgrade_required","client_name":"b4m-android","minimum_version":"2.0.0"}""",
                HttpStatusCode(426, "Upgrade Required"),
                json,
            )
        }
        val signal = ClientUpgradeSignal()
        val transport = B4MTransport(ClientIdentity.android("1.4"), signal, FixedTokens("token-1"))

        val error = assertFailsWith<UpgradeRequiredException> {
            AccountApi("https://app.example.test", engine) { transport.install(it) }.getCreditBalance()
        }

        assertEquals(ClientUpgradeNotice("2.0.0"), error.notice)
        assertEquals(ClientUpgradeNotice("2.0.0"), signal.notice.value)
    }

    @Test
    fun a426WithoutABodyStillRefusesTheBuild() {
        assertEquals(ClientUpgradeNotice(null), ClientUpgradeDetector.notice(426, ""))
        assertNull(ClientUpgradeDetector.notice(400, """{"errorCode":"upgrade_required"}"""))
    }

    @Test
    fun a401RefreshesOnceAndRetriesWithTheNewToken() = runTest {
        val sent = mutableListOf<String?>()
        val engine = MockEngine { request ->
            sent += request.headers[HttpHeaders.Authorization]
            if (sent.size == 1) {
                respond("""{"error":"expired"}""", HttpStatusCode.Unauthorized, json)
            } else {
                respond("""{"balance": 1}""", HttpStatusCode.OK, json)
            }
        }
        val tokens = RotatingTokens()
        val transport = B4MTransport(ClientIdentity.android("1.4"), ClientUpgradeSignal(), tokens)

        AccountApi("https://app.example.test", engine) { transport.install(it) }.getCreditBalance()

        assertEquals(listOf<String?>("Bearer old", "Bearer new"), sent.toList())
        assertEquals(1, tokens.refreshes)
    }

    private class RotatingTokens : BearerTokens {
        private var current = "old"
        var refreshes = 0

        override fun accessToken(): String = current

        override suspend fun refreshAfterUnauthorized(rejectedAccessToken: String?): String {
            refreshes += 1
            current = "new"
            return current
        }
    }

    private class FixedTokens(private val token: String) : BearerTokens {
        override fun accessToken() = token
        override suspend fun refreshAfterUnauthorized(rejectedAccessToken: String?): String? = null
    }
}
