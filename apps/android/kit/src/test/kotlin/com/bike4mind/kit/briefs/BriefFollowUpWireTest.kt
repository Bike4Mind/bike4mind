package com.bike4mind.kit.briefs

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
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class BriefFollowUpWireTest {
    private val environment = ServerEnvironment.Custom("https://staging.example.test")
    private val sent = mutableListOf<Triple<HttpMethod, String, String>>()

    private fun wire(status: HttpStatusCode = HttpStatusCode.OK, body: String) =
        BriefWire(
            environment,
            HttpClient(
                MockEngine { request ->
                    sent += Triple(request.method, request.url.encodedPath, (request.body as? TextContent)?.text.orEmpty())
                    respond(body, status)
                },
            ),
        )

    private val followUpBrief = """
        {"id":"b2","status":"ready","decisions":[
          {"id":"fu-action-1","text":"Book the venue","followUp":{"kind":"actionItem","state":"pending","remindAt":null}},
          {"id":"fu-email","text":"Send follow-up to Sam","followUp":{"kind":"followUpEmail","state":"pending"},
           "draftReply":{"to":"Sam","subject":"Notes","body":"Here are the notes."}},
          {"id":"fu-reminder-1","text":"Remind me: call","followUp":{"kind":"reminder","state":"approved","remindAt":"2026-11-18T09:00:00.000Z"}},
          {"id":"fu-x","text":"New","followUp":{"kind":"calendarHold","state":"snoozed"}},
          {"id":"d1","text":"Legacy decision"}]}
    """.trimIndent()

    @Test
    fun followUpDecisionsDecodeIncludingUnknownAndLegacy() = runTest {
        val decisions = wire(body = followUpBrief).brief("b2").decisions
        assertEquals(BriefFollowUp(FollowUpKind.ACTION_ITEM, FollowUpState.PENDING), decisions[0].followUp)
        assertTrue(decisions[0].followUp!!.isActionable)
        assertEquals(BriefDraftReply("Sam", "Notes", "Here are the notes."), decisions[1].draftReply)
        assertEquals(Instant.parse("2026-11-18T09:00:00Z"), decisions[2].followUp?.remindAt)
        assertFalse(decisions[2].followUp!!.isActionable)
        assertEquals(FollowUpKind.UNKNOWN, decisions[3].followUp?.kind)
        assertFalse(decisions[3].followUp!!.isActionable)
        assertNull(decisions[4].followUp)
        assertNull(decisions[4].draftReply)
    }

    @Test
    fun followUpPostsTheTranscriptAndZone() = runTest {
        wire(HttpStatusCode.Accepted, """{"id":"b3","status":"composing"}""").followUp("Email Sam", "Europe/Paris")
        val (method, path, body) = sent.single()
        assertEquals(HttpMethod.Post, method)
        assertEquals("/api/v1/briefs/follow-ups", path)
        assertEquals("""{"transcript":"Email Sam","timeZone":"Europe/Paris"}""", body)
    }

    @Test
    fun editSendsOnlyTheChangedFields() = runTest {
        val reply = """{"id":"fu-reminder-1","text":"Call","followUp":{"kind":"reminder","state":"pending","remindAt":"2026-11-18T09:00:00Z"}}"""
        val updated = wire(body = reply).editDecision("b2", "fu-reminder-1", BriefDecisionEdit(remindAt = Instant.parse("2026-11-18T09:00:00Z")))
        assertEquals(FollowUpKind.REMINDER, updated.followUp?.kind)
        val (method, path, body) = sent.single()
        assertEquals(HttpMethod.Patch, method)
        assertEquals("/api/v1/briefs/b2/decisions/fu-reminder-1", path)
        assertEquals("""{"remindAt":"2026-11-18T09:00:00Z"}""", body)
    }

    @Test
    fun resolvePostsTheOutcome() = runTest {
        val reply = """{"id":"fu-action-1","text":"Book","followUp":{"kind":"actionItem","state":"dismissed"}}"""
        val updated = wire(body = reply).resolveDecision("b2", "fu-action-1", BriefDecisionOutcome.DISMISS)
        assertEquals(FollowUpState.DISMISSED, updated.followUp?.state)
        val (_, path, body) = sent.single()
        assertEquals("/api/v1/briefs/b2/decisions/fu-action-1/resolve", path)
        assertEquals("""{"outcome":"dismiss"}""", body)
    }

    @Test
    fun statusesMapToTypedFailures() = runTest {
        assertFailsWith<DecisionClosedException> {
            wire(HttpStatusCode.Conflict, """{"error":"Settled","errorCode":"decision_closed"}""").resolveDecision("b2", "fu-email", BriefDecisionOutcome.APPROVE)
        }
        val invalid = assertFailsWith<InvalidDecisionException> {
            wire(HttpStatusCode.BadRequest, """{"error":"Edit the recipient to an email address first"}""").resolveDecision("b2", "fu-email", BriefDecisionOutcome.APPROVE)
        }
        assertEquals("Edit the recipient to an email address first", invalid.message)
        val busy = assertFailsWith<ApiException> {
            wire(HttpStatusCode.Conflict, """{"error":"Busy"}""").resolveDecision("b2", "fu-email", BriefDecisionOutcome.APPROVE)
        }
        assertEquals(409, busy.status)
        assertFailsWith<ApiException> { wire(body = "{}").resolveDecision("../x", "fu-email", BriefDecisionOutcome.APPROVE) }
    }
}
