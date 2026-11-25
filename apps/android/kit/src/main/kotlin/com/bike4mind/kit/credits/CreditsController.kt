package com.bike4mind.kit.credits

import com.bike4mind.kit.account.AccountCallError
import com.bike4mind.kit.account.accountCall
import com.bike4mind.kit.account.accountError
import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class CreditsState(
    val loading: Boolean = true,
    val balance: BigDecimal? = null,
    /** Set when the last load failed. A balance from an earlier load stays on screen; the error shows only without one. */
    val error: AccountCallError? = null,
)

/**
 * The credit balance row in Settings (`GET /api/v1/credits`), loaded when Settings opens. Twin of apps/ios
 * CreditsViewModel, without its TTL and widget feed: the controller lives as long as the Settings screen.
 * [fetch] throws as an account call does (see accountCall).
 */
class CreditsController(private val fetch: suspend () -> BigDecimal, private val scope: CoroutineScope) {
    private val mutableState = MutableStateFlow(CreditsState())
    val state: StateFlow<CreditsState> = mutableState.asStateFlow()

    private var generation = 0

    fun load() {
        val request = ++generation
        mutableState.update { it.copy(loading = true, error = null) }
        scope.launch {
            val result = accountCall { fetch() }
            // A retry tapped while an earlier load was still running owns the row; the earlier answer is dropped.
            if (request != generation) return@launch
            mutableState.update {
                it.copy(
                    loading = false,
                    balance = result?.getOrNull() ?: it.balance,
                    error = result?.exceptionOrNull()?.accountError,
                )
            }
        }
    }

    companion object {
        /** Whole credits with grouping ("31,667"); fractions are noise at this scale. Same rounding as iOS. */
        fun formatted(credits: BigDecimal, locale: Locale = Locale.getDefault()): String =
            NumberFormat.getIntegerInstance(locale).format(credits.setScale(0, RoundingMode.HALF_EVEN))
    }
}
