package com.bike4mind.kit.auth

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
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest

class AuthSessionTest {
    private val json = headersOf(HttpHeaders.ContentType, "application/json")
    private val environment = ServerEnvironment.Custom("https://staging.example.test")

    private class MemoryStore(var tokens: Tokens? = null) : TokenStore {
        override suspend fun load() = tokens
        override suspend fun save(tokens: Tokens) { this.tokens = tokens }
        override suspend fun clear() { tokens = null }
    }

    @Test
    fun exchangeSendsTheGrantAndPersistsTokens() = runTest {
        var body = ""
        val engine = MockEngine { request ->
            assertEquals("/api/oauth/token", request.url.encodedPath)
            body = request.body.toByteArray().decodeToString()
            respond("""{"access_token":"a1","refresh_token":"r1","token_type":"Bearer"}""", HttpStatusCode.OK, json)
        }
        val store = MemoryStore()
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store)
        val request = AuthorizationRequest(environment, OAuthConfiguration.nonProduction, verifier = "v", state = "s")

        session.complete("code-1", request, deviceName = "Pixel")

        assertTrue(session.isSignedIn.value)
        assertEquals(Tokens("a1", "r1"), store.tokens)
        assertEquals(
            """{"grant_type":"authorization_code","code":"code-1","code_verifier":"v","client_id":"b4m-ios-app-dev",""" +
                """"redirect_uri":"com.bike4mind.app://auth-callback","deviceName":"Pixel"}""",
            body,
        )
    }

    @Test
    fun concurrentUnauthorizedCallsShareOneRefresh() = runTest {
        var refreshes = 0
        val engine = MockEngine { request ->
            assertEquals("/api/auth/refreshToken", request.url.encodedPath)
            refreshes++
            respond("""{"accessToken":"a2"}""", HttpStatusCode.OK, json)
        }
        val store = MemoryStore(Tokens("a1", "r1"))
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store).apply { restore() }

        val retried = List(3) { async { session.refreshAfterUnauthorized("a1") } }.awaitAll()

        assertEquals(listOf("a2", "a2", "a2"), retried)
        assertEquals(1, refreshes)
        assertEquals(Tokens("a2", "r1"), store.tokens)
    }

    @Test
    fun aRejectedRefreshSignsOut() = runTest {
        val engine = MockEngine { respond("""{"error":"invalid"}""", HttpStatusCode.Unauthorized, json) }
        val store = MemoryStore(Tokens("a1", "r1"))
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store).apply { restore() }

        assertNull(session.refreshAfterUnauthorized("a1"))
        assertFalse(session.isSignedIn.value)
        assertNull(store.tokens)
    }
}
