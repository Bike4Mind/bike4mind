package com.bike4mind.kit.account

import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.push.NotificationCategory
import java.io.IOException
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class AccountControllersTest {
    private class FakeAccount : AccountApi {
        var profile = AccountProfile("Ada", "ada@example.test")
        var saveFailure: Exception? = null
        var firstSaveFailure: Exception? = null
        var deletion: AccountDeletionOutcome = AccountDeletionOutcome.Scheduled(null)
        var deletionRequests = 0
        var restoreFailure: Exception? = null
        val saved = mutableListOf<Pair<NotificationCategory, Boolean>>()

        override suspend fun profile() = profile
        override suspend fun setPushCategory(category: NotificationCategory, enabled: Boolean) {
            firstSaveFailure?.let {
                firstSaveFailure = null
                throw it
            }
            saveFailure?.let { throw it }
            saved += category to enabled
        }
        override suspend fun requestDeletion(): AccountDeletionOutcome {
            deletionRequests++
            return deletion
        }
        override suspend fun restoreDeletion() {
            restoreFailure?.let { throw it }
        }
    }

    private class FakeStepUp(var options: StepUpOptions, var outcome: StepUpOutcome = StepUpOutcome.Verified(null)) : StepUpApi {
        var proofs = mutableListOf<StepUpProof>()
        override suspend fun options() = options
        override suspend fun sendEmailCode() = "pending-1"
        override suspend fun verify(proof: StepUpProof): StepUpOutcome {
            proofs += proof
            return outcome
        }
    }

    @Test
    fun aSwitchSavesAndAFailedSaveMovesItBack() = runTest {
        val api = FakeAccount()
        val settings = SettingsController(api, this)
        settings.load()
        runCurrent()

        settings.setEnabled(NotificationCategory.BRIEF_READY, false)
        assertFalse(settings.state.value.isEnabled(NotificationCategory.BRIEF_READY))
        runCurrent()
        assertEquals(listOf(NotificationCategory.BRIEF_READY to false), api.saved)

        api.saveFailure = IOException("offline")
        settings.setEnabled(NotificationCategory.AGENT_FAILED, false)
        runCurrent()
        assertTrue(settings.state.value.isEnabled(NotificationCategory.AGENT_FAILED))
        assertFalse(settings.state.value.isEnabled(NotificationCategory.BRIEF_READY))
        assertEquals(AccountCallError.OFFLINE, settings.state.value.saveError)
    }

    @Test
    fun theLatestTapWinsWhenAnEarlierSaveFailsLate() = runTest {
        val api = FakeAccount()
        val settings = SettingsController(api, this)
        settings.load()
        runCurrent()

        api.firstSaveFailure = IOException("offline")
        settings.setEnabled(NotificationCategory.BRIEF_READY, false)
        settings.setEnabled(NotificationCategory.BRIEF_READY, true)
        settings.setEnabled(NotificationCategory.BRIEF_READY, false)
        runCurrent()

        assertFalse(settings.state.value.isEnabled(NotificationCategory.BRIEF_READY))
        assertEquals(
            listOf(NotificationCategory.BRIEF_READY to true, NotificationCategory.BRIEF_READY to false),
            api.saved,
        )
    }

    @Test
    fun deletionNeedsTheTypedWordAndEndsTheSessionOnlyWhenAccepted() = runTest {
        val api = FakeAccount()
        var ended = 0
        val deletion = AccountDeletionController(api, this) { ended++ }

        deletion.setConfirmation("delete")
        deletion.submit()
        runCurrent()
        assertEquals(0, api.deletionRequests)

        api.deletion = AccountDeletionOutcome.Failed(AccountDeletionFailure.StepUpRequired)
        deletion.setConfirmation(" DELETE ")
        deletion.submit()
        runCurrent()
        assertTrue(deletion.state.value.needsStepUp)
        assertEquals(0, ended)

        val purge = Instant.parse("2026-12-20T10:00:00Z")
        api.deletion = AccountDeletionOutcome.Scheduled(purge)
        deletion.submit()
        runCurrent()
        assertEquals(AccountDeletionPhase.Completed(purge), deletion.state.value.phase)
        assertEquals(1, ended)
        deletion.submit()
        runCurrent()
        assertEquals(2, api.deletionRequests)
    }

    @Test
    fun anOpenStepUpWindowSkipsTheProof() = runTest {
        var verified = 0
        val now = Instant.parse("2026-11-20T10:00:00Z")
        val api = FakeStepUp(StepUpOptions(listOf(StepUpMethod.PASSWORD), now.plusSeconds(60)))
        val stepUp = StepUpController(api, this, { now }, onVerified = { verified++ }, onSessionEnded = {})

        stepUp.load()
        runCurrent()

        assertEquals(StepUpPhase.Verified, stepUp.state.value.phase)
        assertEquals(1, verified)
        assertTrue(api.proofs.isEmpty())
    }

    @Test
    fun anEmailedCodeIsSentWithItsPendingToken() = runTest {
        var verified = 0
        val api = FakeStepUp(StepUpOptions(listOf(StepUpMethod.PASSWORD, StepUpMethod.EMAIL), null))
        val stepUp = StepUpController(api, this, onVerified = { verified++ }, onSessionEnded = {})
        stepUp.load()
        runCurrent()

        stepUp.select(StepUpMethod.EMAIL)
        stepUp.setCode("111111")
        assertFalse(stepUp.state.value.canSubmit)
        stepUp.sendEmailCode()
        runCurrent()
        stepUp.setCode(" 222222 ")
        stepUp.submit()
        runCurrent()

        assertEquals(listOf<StepUpProof>(StepUpProof.Email("pending-1", "222222")), api.proofs)
        assertEquals(1, verified)
    }

    @Test
    fun aRevokedSessionAfterWrongPasswordsSignsOut() = runTest {
        var ended = 0
        val api = FakeStepUp(StepUpOptions(listOf(StepUpMethod.PASSWORD), null), StepUpOutcome.Failed(StepUpFailure.SessionEnded))
        val stepUp = StepUpController(api, this, onVerified = {}, onSessionEnded = { ended++ })
        stepUp.load()
        runCurrent()

        stepUp.setPassword("wrong")
        stepUp.submit()
        runCurrent()

        assertEquals(1, ended)
        assertEquals("", stepUp.state.value.password)
    }

    @Test
    fun restoreReportsFailureAndCallsBackOnSuccess() = runTest {
        val api = FakeAccount()
        var restored = 0
        val restore = AccountRestoreController(api, this) { restored++ }

        api.restoreFailure = ApiException(409)
        restore.restore()
        runCurrent()
        assertEquals(AccountCallError.SERVER, restore.state.value.error)
        assertEquals(0, restored)

        api.restoreFailure = null
        restore.restore()
        runCurrent()
        assertEquals(AccountRestoreState(), restore.state.value)
        assertEquals(1, restored)
    }
}
