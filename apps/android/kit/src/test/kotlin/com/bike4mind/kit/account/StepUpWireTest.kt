package com.bike4mind.kit.account

import com.bike4mind.kit.environment.ServerEnvironment
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest

class StepUpWireTest {
    private val password = StepUpProof.Password("pw")
    private val totp = StepUpProof.Totp("123456")

    private fun failure(status: Int, body: String, proof: StepUpProof = totp) =
        (StepUpWire.verifyOutcome(status, body, proof) as StepUpOutcome.Failed).failure

    @Test
    fun aPassedProofReadsTheWindow() {
        assertEquals(
            StepUpOutcome.Verified(Instant.parse("2026-11-20T10:05:00Z")),
            StepUpWire.verifyOutcome(200, """{"stepUpUntil":"2026-11-20T10:05:00.000Z"}""", totp),
        )
    }

    @Test
    fun aRejectedProofKeepsTheServerTextAndAttempts() {
        assertEquals(
            StepUpFailure.Rejected("Invalid code.", 2),
            failure(400, """{"error":"Invalid code.","code":"step_up_failed","attemptsRemaining":2}"""),
        )
        // Zero attempts on a code means "ask for a new one"; on a password the server revoked the session.
        assertEquals(StepUpFailure.Rejected("Expired", 0), failure(400, """{"error":"Expired","code":"step_up_failed","attemptsRemaining":0}"""))
        assertEquals(
            StepUpFailure.SessionEnded,
            failure(400, """{"error":"Wrong","code":"step_up_failed","attemptsRemaining":0}""", password),
        )
        assertEquals(StepUpFailure.Server(400), failure(400, """{"error":"This verification method is not available"}"""))
    }

    @Test
    fun lockoutsAndUnavailableSessionsMap() {
        assertEquals(StepUpFailure.RateLimited, failure(429, ""))
        assertEquals(StepUpFailure.RateLimited, failure(423, ""))
        assertEquals(StepUpFailure.SessionEnded, failure(403, """{"code":"step_up_unavailable"}"""))
        assertEquals(StepUpFailure.Server(403), failure(403, "{}"))
    }

    @Test
    fun optionsKeepOnlyMethodsThisAppCanCollect() = runTest {
        val wire = StepUpWire(ServerEnvironment.Custom("https://staging.example.test"), HttpClient(MockEngine {
            respond("""{"methods":["passkey","totp","email"],"stepUpUntil":null}""", HttpStatusCode.OK)
        }))

        assertEquals(StepUpOptions(listOf(StepUpMethod.TOTP, StepUpMethod.EMAIL), null), wire.options())
    }
}
