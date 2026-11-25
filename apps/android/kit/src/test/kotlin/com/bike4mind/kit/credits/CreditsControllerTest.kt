package com.bike4mind.kit.credits

import com.bike4mind.kit.account.AccountCallError
import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.ClientUpgradeNotice
import com.bike4mind.kit.networking.UpgradeRequiredException
import java.io.IOException
import java.math.BigDecimal
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class CreditsControllerTest {
    @Test
    fun loadsTheBalance() = runTest {
        val credits = CreditsController({ BigDecimal("31666.6") }, this)
        credits.load()
        runCurrent()

        assertEquals(CreditsState(loading = false, balance = BigDecimal("31666.6")), credits.state.value)
    }

    @Test
    fun aFailureIsShownAndARetryClearsIt() = runTest {
        var failure: Exception? = IOException("offline")
        val credits = CreditsController({ failure?.let { throw it } ?: BigDecimal.TEN }, this)
        credits.load()
        runCurrent()
        assertEquals(CreditsState(loading = false, error = AccountCallError.OFFLINE), credits.state.value)

        failure = null
        credits.load()
        runCurrent()
        assertEquals(CreditsState(loading = false, balance = BigDecimal.TEN), credits.state.value)
    }

    @Test
    fun aFailedReloadKeepsTheBalanceItAlreadyHas() = runTest {
        var failure: Exception? = null
        val credits = CreditsController({ failure?.let { throw it } ?: BigDecimal.TEN }, this)
        credits.load()
        runCurrent()

        failure = ApiException(503)
        credits.load()
        runCurrent()
        assertEquals(BigDecimal.TEN, credits.state.value.balance)
        assertEquals(AccountCallError.SERVER, credits.state.value.error)
    }

    @Test
    fun aRefusedBuildIsNotShownAsAnError() = runTest {
        val credits = CreditsController({ throw UpgradeRequiredException(ClientUpgradeNotice(null)) }, this)
        credits.load()
        runCurrent()

        assertFalse(credits.state.value.loading)
        assertNull(credits.state.value.error)
    }

    @Test
    fun anEarlierLoadThatAnswersLateNeverOverwritesTheRetry() = runTest {
        val first = CompletableDeferred<BigDecimal>()
        var calls = 0
        val credits = CreditsController({ if (++calls == 1) first.await() else BigDecimal.TEN }, this)
        credits.load()
        runCurrent()
        credits.load()
        runCurrent()

        first.complete(BigDecimal.ONE)
        runCurrent()
        assertEquals(BigDecimal.TEN, credits.state.value.balance)
    }

    @Test
    fun formatsWholeCreditsWithGrouping() {
        assertEquals("31,667", CreditsController.formatted(BigDecimal("31666.6"), Locale.US))
        assertEquals("31.667", CreditsController.formatted(BigDecimal("31666.6"), Locale.GERMANY))
        assertEquals("0", CreditsController.formatted(BigDecimal("0.5"), Locale.US))
        assertEquals("0", CreditsController.formatted(BigDecimal("-0.4"), Locale.US))
        assertEquals("-1,200", CreditsController.formatted(BigDecimal("-1200"), Locale.US))
    }
}
