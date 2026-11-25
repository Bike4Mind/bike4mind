package com.bike4mind.kit.briefs

import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class BriefWireTest {
    private val environment = ServerEnvironment.Custom("https://staging.example.test")

    private fun wire(status: HttpStatusCode = HttpStatusCode.OK, body: String, onRequest: (HttpMethod, String) -> Unit = { _, _ -> }) =
        BriefWire(
            environment,
            HttpClient(
                MockEngine { request ->
                    onRequest(request.method, request.url.encodedPath)
                    respond(body, status)
                },
            ),
        )

    @Test
    fun readsAReadyBriefWithAnApprovalDecision() = runTest {
        var path = ""
        val brief = wire(body = READY_BRIEF) { _, requested -> path = requested }.brief("b1")

        assertEquals("/api/v1/briefs/b1", path)
        assertEquals(BriefStatus.READY, brief.status)
        assertEquals("1 decision needs you.", brief.headline)
        assertEquals(Instant.parse("2026-11-17T09:00:00.000Z"), brief.periodStart)
        assertEquals(listOf(BriefItem("h1", "Ran the weekly report.")), brief.happened)
        assertEquals(BriefApprovalRef("q1", "s1", 1763370000000), brief.decisions.single().approval)
        assertFalse(brief.isEmpty)
    }

    @Test
    fun anUnknownStatusAndUnknownFieldsStillDecode() = runTest {
        val brief = wire(body = """{"id":"b1","status":"archived","createdAt":"x","composedAt":null,"periodStart":"2026-11-17T09:00:00Z","periodEnd":"2026-11-18T09:00:00Z","headline":null,"happened":[],"handled":[],"decisions":[],"later":1}""")
            .brief("b1")

        assertEquals(BriefStatus.UNKNOWN, brief.status)
        assertNull(brief.createdAt)
        assertTrue(brief.isEmpty)
    }

    @Test
    fun composePostsAndListGets() = runTest {
        val calls = mutableListOf<Pair<HttpMethod, String>>()
        val composing = """{"id":"b2","status":"composing","createdAt":"2026-11-18T09:00:00Z","composedAt":null,"periodStart":"2026-11-17T09:00:00Z","periodEnd":"2026-11-18T09:00:00Z","headline":null,"happened":[],"handled":[],"decisions":[]}"""
        assertEquals(BriefStatus.COMPOSING, wire(HttpStatusCode.Accepted, composing) { m, p -> calls += m to p }.compose().status)
        assertEquals(listOf("b1"), wire(body = """{"briefs":[$READY_BRIEF]}""") { m, p -> calls += m to p }.list().map { it.id })
        assertEquals(listOf(HttpMethod.Post to "/api/v1/briefs", HttpMethod.Get to "/api/v1/briefs"), calls)
    }

    @Test
    fun anObligationSourcedItemDecodes() = runTest {
        val brief = wire(body = """{"id":"b1","status":"ready","createdAt":"x","composedAt":null,"periodStart":"2026-11-17T09:00:00Z","periodEnd":"2026-11-18T09:00:00Z","headline":null,"happened":[{"id":"h1","text":"Due Dec 5: City Water ${'$'}120.50","source":{"kind":"obligation","obligationId":"ob-1"}}],"handled":[],"decisions":[]}""")
            .brief("b1")

        assertEquals(listOf(BriefItem("h1", "Due Dec 5: City Water ${'$'}120.50")), brief.happened)
    }

    @Test
    fun aMissingBriefIsA404() = runTest {
        val failure = assertFailsWith<ApiException> { wire(HttpStatusCode.NotFound, "{}").brief("b1") }
        assertEquals(404, failure.status)
    }

    @Test
    fun aMalformedIdNeverReachesTheServer() = runTest {
        var called = false
        val wire = wire(body = READY_BRIEF) { _, _ -> called = true }
        for (id in listOf("", "../me", "a/b", "x".repeat(65))) {
            assertFailsWith<ApiException> { wire.brief(id) }
        }
        assertFalse(called)
    }

    @Test
    fun aBodyThatIsNotABriefIsMalformed() = runTest {
        assertFailsWith<MalformedBriefException> { wire(body = """{"nope":true}""").brief("b1") }
    }

    private companion object {
        const val READY_BRIEF = """{"id":"b1","status":"ready","createdAt":"2026-11-18T09:00:00.000Z","composedAt":"2026-11-18T09:00:30.000Z","periodStart":"2026-11-17T09:00:00.000Z","periodEnd":"2026-11-18T09:00:00.000Z","headline":"1 decision needs you.","happened":[{"id":"h1","text":"Ran the weekly report."}],"handled":[],"decisions":[{"id":"d1","text":"Approve sending the invoice?","approval":{"questId":"q1","sessionId":"s1","pendingActionTs":1763370000000}}]}"""
    }
}
