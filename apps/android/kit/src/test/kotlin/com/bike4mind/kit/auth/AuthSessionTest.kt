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
import kotlin.test.assertFailsWith
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
        var pending: List<PendingRevocation> = emptyList()
        var loadFailure: Exception? = null
        override suspend fun load() = tokens
        override suspend fun save(tokens: Tokens) { this.tokens = tokens }
        override suspend fun clear() { tokens = null }
        override suspend fun loadPendingRevocations(): List<PendingRevocation> {
            loadFailure?.let { throw it }
            return pending
        }
        override suspend fun savePendingRevocations(revocations: List<PendingRevocation>) { pending = revocations }
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
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store, { NOW })
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
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store, { NOW }).apply { restore() }

        val retried = List(3) { async { session.refreshAfterUnauthorized("a1") } }.awaitAll()

        assertEquals(listOf("a2", "a2", "a2"), retried)
        assertEquals(1, refreshes)
        assertEquals(Tokens("a2", "r1"), store.tokens)
    }

    @Test
    fun aRejectedRefreshSignsOut() = runTest {
        val engine = MockEngine { respond("""{"error":"invalid"}""", HttpStatusCode.Unauthorized, json) }
        val store = MemoryStore(Tokens("a1", "r1"))
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store, { NOW }).apply { restore() }

        assertNull(session.refreshAfterUnauthorized("a1"))
        assertFalse(session.isSignedIn.value)
        assertNull(store.tokens)
    }

    @Test
    fun anOfflineSignOutIsKeptAndFinishedOnceTheServerAnswers() = runTest {
        var online = false
        val logouts = mutableListOf<String?>()
        val engine = MockEngine { request ->
            when (request.url.encodedPath) {
                "/api/logout" -> {
                    if (!online) throw java.io.IOException("offline")
                    logouts += request.headers[HttpHeaders.Authorization]
                    respond("", HttpStatusCode.OK)
                }
                "/api/auth/refreshToken" -> respond("""{"accessToken":"a2","refreshToken":"r2"}""", HttpStatusCode.OK, json)
                else -> error("unexpected ${request.url}")
            }
        }
        val store = MemoryStore(Tokens("a1", "r1"))
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store, { NOW }).apply { restore() }

        session.signOut()

        assertFalse(session.isSignedIn.value)
        assertNull(store.tokens)
        assertEquals(listOf(PendingRevocation(environment.baseUrl, "r1", NOW)), store.pending)

        session.retryPendingRevocations()
        assertEquals(listOf(PendingRevocation(environment.baseUrl, "r2", NOW)), store.pending)

        online = true
        session.retryPendingRevocations()

        assertEquals(emptyList(), store.pending)
        assertEquals(listOf<String?>("Bearer a2"), logouts)
        assertFalse(session.isSignedIn.value)
    }

    @Test
    fun aPendingRevocationTheServerAlreadyEndedIsDropped() = runTest {
        val engine = MockEngine { respond("""{"error":"invalid"}""", HttpStatusCode.Unauthorized, json) }
        val store = MemoryStore().apply { pending = listOf(PendingRevocation(environment.baseUrl, "r9", NOW)) }
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store, { NOW })

        session.retryPendingRevocations()

        assertEquals(emptyList(), store.pending)
    }

    @Test
    fun aRetryThatFailsInTheStoreDoesNotBlockTheNextOne() = runTest {
        val engine = MockEngine { respond("""{"error":"invalid"}""", HttpStatusCode.Unauthorized, json) }
        val store = MemoryStore().apply {
            pending = listOf(PendingRevocation(environment.baseUrl, "r9", NOW))
            loadFailure = IllegalStateException("store unavailable")
        }
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store, { NOW })

        assertFailsWith<IllegalStateException> { session.retryPendingRevocations() }
        store.loadFailure = null
        session.retryPendingRevocations()

        assertEquals(emptyList(), store.pending)
    }

    @Test
    fun pendingRevocationsAreBoundedByAgeAndCount() = runTest {
        val engine = MockEngine { respond("", HttpStatusCode.ServiceUnavailable) }
        val expired = PendingRevocation("https://other.example.test", "old", NOW - PendingRevocation.MAX_AGE_MILLIS)
        val fresh = (0 until PendingRevocation.MAX_COUNT).map {
            PendingRevocation("https://other.example.test", "o$it", NOW)
        }
        val store = MemoryStore(Tokens("a1", "r1")).apply { pending = listOf(expired) + fresh }
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store, { NOW }).apply { restore() }

        session.signOut()

        assertEquals(PendingRevocation.MAX_COUNT, store.pending.size)
        assertFalse(expired in store.pending)
        assertEquals(PendingRevocation(environment.baseUrl, "r1", NOW), store.pending.last())
    }

    @Test
    fun anOnlineSignOutLeavesNothingPending() = runTest {
        val engine = MockEngine { respond("", HttpStatusCode.OK) }
        val store = MemoryStore(Tokens("a1", "r1"))
        val session = AuthSession(AuthApi(environment, HttpClient(engine)), store, { NOW }).apply { restore() }

        session.signOut()

        assertEquals(emptyList(), store.pending)
        assertNull(store.tokens)
    }

    private companion object {
        const val NOW = 1_800_000_000_000L
    }
}
