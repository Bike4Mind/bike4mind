package com.bike4mind.kit.account

import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.B4MTransport
import com.bike4mind.kit.networking.BearerTokens
import com.bike4mind.kit.networking.ClientIdentity
import com.bike4mind.kit.networking.ClientUpgradeSignal
import com.bike4mind.kit.push.NotificationCategory
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.get
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import java.time.Instant
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class AccountWireTest {
    private val environment = ServerEnvironment.Custom("https://staging.example.test")

    private fun failure(status: Int, body: String = "") =
        (AccountWire.deletionOutcome(status, body) as AccountDeletionOutcome.Failed).failure

    @Test
    fun anAcceptedDeletionReadsThePurgeDate() {
        assertEquals(
            AccountDeletionOutcome.Scheduled(Instant.parse("2026-12-20T10:00:00Z")),
            AccountWire.deletionOutcome(202, """{"deletion":{"scheduledFor":"2026-12-20T10:00:00.000Z"}}"""),
        )
        assertEquals(AccountDeletionOutcome.Scheduled(null), AccountWire.deletionOutcome(202, ""))
    }

    @Test
    fun forbiddenSplitsStepUpFromARefusedSession() {
        assertEquals(AccountDeletionFailure.StepUpRequired, failure(403, """{"code":"step_up_required"}"""))
        assertEquals(AccountDeletionFailure.StepUpUnavailable, failure(403, """{"code":"step_up_unavailable"}"""))
        assertEquals(AccountDeletionFailure.NotPermitted, failure(403, """{"error":"Forbidden"}"""))
    }

    @Test
    fun ownedOrganizationsAreListedAndAnyOtherConflictIsAlreadyScheduled() {
        val body = """{"code":"ACCOUNT_DELETION_ORG_OWNER","organizations":[{"id":"o1","name":" Acme "},{"id":"","name":"x"},{"id":"o2","name":" "}]}"""
        assertEquals(
            AccountDeletionFailure.OrganizationTransferRequired(listOf(AccountOrganization("o1", "Acme"), AccountOrganization("o2", null))),
            failure(409, body),
        )
        assertEquals(AccountDeletionFailure.AlreadyScheduled, failure(409))
        assertEquals(AccountDeletionFailure.SignedOut, failure(401))
        assertEquals(AccountDeletionFailure.Server(500), failure(500))
    }

    @Test
    fun theProfileCarriesNameEmailAndPushOptOuts() {
        val profile = AccountProfile.fromUserJson(
            """{"name":" Ada Lovelace ","email":"ada@example.test","preferences":{"pushNotifications":{"brief_ready":false,"agent_failed":true,"future_kind":false}}}""",
        )!!
        assertEquals("Ada Lovelace", profile.displayName)
        assertEquals("A", profile.initial)
        assertEquals("ada@example.test", profile.email)
        assertFalse(profile.isEnabled(NotificationCategory.BRIEF_READY))
        assertTrue(profile.isEnabled(NotificationCategory.AGENT_FAILED))
        assertTrue(profile.isEnabled(NotificationCategory.CHAT_COMPLETED))
        assertEquals("ada", AccountProfile.fromUserJson("""{"username":"ada"}""")?.displayName)
    }

    @Test
    fun theUserIdComesFromTheTokenIdClaim() {
        fun token(claims: String) = "h." + Base64.getUrlEncoder().withoutPadding().encodeToString(claims.toByteArray()) + ".s"
        assertEquals("u_123", AccountProfile.userId(token("""{"id":"u_123"}""")))
        assertNull(AccountProfile.userId(token("""{"id":"../x"}""")))
        assertNull(AccountProfile.userId("not-a-jwt"))
    }

    @Test
    fun aSwitchWritesOnlyItsOwnCategory() = runTest {
        var method: HttpMethod? = null
        var path = ""
        var body = ""
        val wire = AccountWire(environment, HttpClient(MockEngine { request ->
            method = request.method
            path = request.url.encodedPath
            body = (request.body as TextContent).text
            respond("{}", HttpStatusCode.OK)
        })) { "u1" }

        wire.setPushCategory(NotificationCategory.BRIEF_READY, false)

        assertEquals(HttpMethod.Put, method)
        assertEquals("/api/users/u1/update", path)
        assertEquals("""{"preferences":{"pushNotifications":{"brief_ready":false}}}""", body)
    }

    @Test
    fun restoreTreatsNothingScheduledAsRestored() = runTest {
        var status = HttpStatusCode.NotFound
        val wire = AccountWire(environment, HttpClient(MockEngine { request ->
            assertEquals(HttpMethod.Delete, request.method)
            assertEquals("/api/account/deletion", request.url.encodedPath)
            respond("", status)
        })) { "u1" }

        wire.restoreDeletion()
        status = HttpStatusCode.Conflict
        assertEquals(409, assertFailsWith<ApiException> { wire.restoreDeletion() }.status)
    }

    @Test
    fun onlyThePendingDeletionCodeRaisesTheGate() {
        val pending = """{"code":"ACCOUNT_DELETION_PENDING","scheduledFor":"2026-12-20T10:00:00Z","error":"x"}"""
        assertEquals(AccountDeletionNotice(Instant.parse("2026-12-20T10:00:00Z")), AccountDeletionPendingDetector.notice(403, pending))
        assertNull(AccountDeletionPendingDetector.notice(403, """{"code":"step_up_required"}"""))
        assertNull(AccountDeletionPendingDetector.notice(409, pending))
        assertNull(AccountDeletionPendingDetector.notice(403, ""))
    }

    @Test
    fun theTransportReportsAPendingDeletionFromAnyCall() = runTest {
        val signal = AccountDeletionSignal()
        val transport = B4MTransport(ClientIdentity.android("1.0"), ClientUpgradeSignal(), NoTokens, signal)
        val http = HttpClient(MockEngine {
            respond("""{"code":"ACCOUNT_DELETION_PENDING","scheduledFor":"2026-12-20T10:00:00Z"}""", HttpStatusCode.Forbidden)
        }) { transport.install(this) }

        http.get("https://staging.example.test/api/sessions")
        assertEquals(Instant.parse("2026-12-20T10:00:00Z"), signal.notice.value?.scheduledFor)

        signal.reset()
        signal.beginSignOutAfterDeletion()
        http.get("https://staging.example.test/api/sessions")
        assertNull(signal.notice.value)
    }

    private object NoTokens : BearerTokens {
        override fun accessToken(): String? = null
        override suspend fun refreshAfterUnauthorized(rejectedAccessToken: String?): String? = null
    }
}
