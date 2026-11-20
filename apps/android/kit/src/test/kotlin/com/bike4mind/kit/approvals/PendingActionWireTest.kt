package com.bike4mind.kit.approvals

import com.bike4mind.kit.approvals.PendingActionDecision.APPROVE
import com.bike4mind.kit.approvals.PendingActionDecision.DENY
import com.bike4mind.kit.environment.ServerEnvironment
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class PendingActionWireTest {
    private val environment = ServerEnvironment.Custom("https://staging.example.test")

    private fun failure(status: Int, body: String = "") =
        (PendingActionWire.outcome(status, body, APPROVE) as PendingActionOutcome.Failed).failure

    @Test
    fun aSuccessReadsTheToolResult() {
        assertEquals(
            PendingActionOutcome.Answered(PendingActionResult(APPROVE, toolSucceeded = true, message = "Done")),
            PendingActionWire.outcome(200, """{"success":true,"message":"Done"}""", APPROVE),
        )
        assertEquals(
            PendingActionOutcome.Answered(PendingActionResult(DENY, toolSucceeded = false, message = "Tool failed")),
            PendingActionWire.outcome(200, """{"success":false,"message":"Tool failed"}""", DENY),
        )
        assertEquals(PendingActionOutcome.Answered(PendingActionResult(APPROVE)), PendingActionWire.outcome(200, "not json", APPROVE))
    }

    @Test
    fun conflictsMapToTheLifecycleCases() {
        assertEquals(PendingActionFailure.Replaced, failure(409, """{"errorCode":"action_replaced"}"""))
        assertEquals(PendingActionFailure.Expired, failure(409, """{"errorCode":"action_expired"}"""))
        assertEquals(PendingActionFailure.AlreadyResolved, failure(409, """{"errorCode":"action_already_resolved"}"""))
        assertEquals(PendingActionFailure.AlreadyResolved, failure(409))
    }

    @Test
    fun otherClientErrorsAreSettledRefusals() {
        assertEquals(PendingActionFailure.NotFound, failure(404))
        assertEquals(PendingActionFailure.SignedOut, failure(401))
        assertEquals(PendingActionFailure.UpgradeRequired, failure(426))
        assertEquals(PendingActionFailure.Refused("Repository not enabled"), failure(400, """{"error":"  Repository not enabled "}"""))
        assertEquals(PendingActionFailure.Refused(null), failure(422, """{"error":" "}"""))
        assertFalse(failure(400).isRetryable)
    }

    @Test
    fun busyAndServerErrorsCanBeRetried() {
        assertEquals(PendingActionFailure.RateLimited, failure(429))
        assertEquals(PendingActionFailure.ServerError, failure(503))
        assertTrue(failure(429).isRetryable)
        assertTrue(failure(500).isRetryable)
        assertFalse(failure(409).isRetryable)
    }

    @Test
    fun postsTheTimestampToTheDecisionRoute() = runTest {
        var path = ""
        var body = ""
        val wire = PendingActionWire(
            environment,
            HttpClient(
                MockEngine { request ->
                    path = request.url.encodedPath
                    body = (request.body as TextContent).text
                    respond("""{"success":true}""", HttpStatusCode.OK)
                },
            ),
        )

        val outcome = wire.respond(PendingActionTarget("q1", 1_700_000_000_123), DENY)

        assertEquals("/api/v1/pending-actions/q1/deny", path)
        assertEquals("""{"pendingActionTs":1700000000123}""", body)
        assertEquals(PendingActionOutcome.Answered(PendingActionResult(DENY)), outcome)
    }

    @Test
    fun aMalformedTargetNeverReachesTheServer() = runTest {
        var requests = 0
        val wire = PendingActionWire(environment, HttpClient(MockEngine { requests++; respond("", HttpStatusCode.OK) }))

        assertEquals(PendingActionOutcome.Failed(PendingActionFailure.Unavailable), wire.respond(PendingActionTarget("../q1", 1), APPROVE))
        assertEquals(PendingActionOutcome.Failed(PendingActionFailure.Unavailable), wire.respond(PendingActionTarget("q1", 0), APPROVE))
        assertEquals(0, requests)
    }

    @Test
    fun aDroppedConnectionIsOffline() = runTest {
        val wire = PendingActionWire(environment, HttpClient(MockEngine { throw IOException("offline") }))

        assertEquals(PendingActionOutcome.Failed(PendingActionFailure.Offline), wire.respond(PendingActionTarget("q1", 1), APPROVE))
    }

    @Test
    fun onlyAnOpenCardOrARetryableFailureOffersADecision() {
        assertTrue(ApprovalCardState.Open.offersDecision)
        assertTrue(ApprovalCardState.Failed(PendingActionFailure.Offline).offersDecision)
        assertFalse(ApprovalCardState.Failed(PendingActionFailure.Expired).offersDecision)
        assertFalse(ApprovalCardState.Submitting(APPROVE).offersDecision)
        assertFalse(ApprovalCardState.Answered(PendingActionResult(APPROVE)).offersDecision)
    }
}
