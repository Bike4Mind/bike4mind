package com.bike4mind.kit.obligations

import com.bike4mind.kit.capture.CaptureApi
import com.bike4mind.kit.capture.CaptureRejectedException
import com.bike4mind.kit.networking.ApiException
import java.io.File
import java.io.IOException
import java.math.BigDecimal
import java.text.DecimalFormat
import java.text.NumberFormat
import java.text.ParsePosition
import java.util.Currency
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class HandoffPhase { UPLOADING, EXTRACTING, REVIEWING, SAVING, DONE, FAILED }

enum class AmountProblem { NOT_A_NUMBER, NEGATIVE }

data class HandoffState(
    val phase: HandoffPhase = HandoffPhase.UPLOADING,
    val obligation: Obligation? = null,
    val lakes: List<LakeOption> = emptyList(),
    val amountText: String = "",
    val currency: String = "USD",
    val payee: String = "",
    /** `YYYY-MM-DD` or null. */
    val dueDate: String? = null,
    val destinationLakeId: String? = null,
    /** Why loading failed ([HandoffPhase.FAILED]) or the last confirm failed (edits kept). */
    val problem: HandoffProblem? = null,
)

enum class HandoffProblem { NOT_FOUND, STILL_CHECKING, DISMISSED, REJECTED, OFFLINE, GENERIC }

/**
 * Drives "Hand to assistant" for a scanned document, mirroring the iOS ObligationHandoffModel: upload the scan,
 * have the assistant read the bill, let the user correct it, then confirm. A failed confirm keeps every edit.
 */
class ObligationHandoffController(
    private val capture: CaptureApi,
    private val obligations: ObligationsApi,
    private val locale: Locale = Locale.getDefault(),
    private val retryDelayMillis: Long = 750,
    private val maximumAttempts: Int = 40,
) {
    private val mutableState = MutableStateFlow(
        HandoffState(currency = runCatching { Currency.getInstance(locale).currencyCode }.getOrNull() ?: "USD"),
    )
    val state: StateFlow<HandoffState> = mutableState.asStateFlow()

    /** The server's message for a [HandoffProblem.REJECTED] problem, safe to show. */
    var rejectionMessage: String? = null
        private set

    val parsedAmount: Result<BigDecimal?> get() = parseAmount(state.value.amountText, locale)

    val canConfirm: Boolean
        get() = state.value.phase == HandoffPhase.REVIEWING && state.value.obligation != null && parsedAmount.isSuccess

    fun edit(transform: (HandoffState) -> HandoffState) = mutableState.update(transform)

    suspend fun start(file: File, text: String?) {
        mutableState.update { it.copy(phase = HandoffPhase.UPLOADING, problem = null) }
        try {
            val ticket = capture.createUpload(file.name, "application/pdf", file.length())
            capture.upload(ticket, file, "application/pdf")
            mutableState.update { it.copy(phase = HandoffPhase.EXTRACTING) }
            val extracted = handOffWhenChecked(ticket.fileId, text?.trim()?.takeIf { it.isNotEmpty() }?.let(::capHandOffText))
            val lakes = runCatching { obligations.lakes() }.getOrDefault(emptyList()).let { listed ->
                val suggested = extracted.destination
                if (suggested == null || listed.any { it.id == suggested.lakeId }) listed
                else listOf(LakeOption(suggested.lakeId, suggested.name)) + listed
            }
            mutableState.update {
                it.copy(
                    phase = HandoffPhase.REVIEWING,
                    obligation = extracted,
                    lakes = lakes,
                    amountText = extracted.amount?.let { amount -> format(BigDecimal.valueOf(amount.value)) } ?: "",
                    currency = extracted.amount?.currency ?: it.currency,
                    payee = extracted.payee ?: "",
                    dueDate = extracted.dueDate,
                    destinationLakeId = extracted.destination?.lakeId,
                )
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            mutableState.update { it.copy(phase = HandoffPhase.FAILED, problem = problemFor(failure)) }
        }
    }

    suspend fun confirm() {
        val current = state.value
        val original = current.obligation ?: return
        val amount = parsedAmount.getOrElse { return }
        mutableState.update { it.copy(phase = HandoffPhase.SAVING, problem = null) }
        try {
            val saved = obligations.update(original.id, patch(current, original, amount))
            mutableState.update { it.copy(phase = HandoffPhase.DONE, obligation = saved) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            mutableState.update { it.copy(phase = HandoffPhase.REVIEWING, problem = problemFor(failure)) }
        }
    }

    /** Only the fields the user changed, plus the confirmation. */
    internal fun patch(current: HandoffState, original: Obligation, amount: BigDecimal?): ObligationPatch {
        val originalAmount = original.amount?.let { BigDecimal.valueOf(it.value) to it.currency }
        val sameAmount = amount == null && originalAmount == null ||
            amount != null && originalAmount != null && amount.compareTo(originalAmount.first) == 0 &&
            current.currency == originalAmount.second
        val payee = current.payee.trim().ifEmpty { null }
        return ObligationPatch(
            amount = if (sameAmount) PatchField.Unchanged else PatchField.Set(amount?.let { it to current.currency }),
            payee = if (payee == original.payee) PatchField.Unchanged else PatchField.Set(payee),
            dueDate = if (current.dueDate == original.dueDate) PatchField.Unchanged else PatchField.Set(current.dueDate),
            destinationLakeId = if (current.destinationLakeId == original.destination?.lakeId) {
                PatchField.Unchanged
            } else {
                PatchField.Set(current.destinationLakeId)
            },
            status = "confirmed",
        )
    }

    private suspend fun handOffWhenChecked(fileId: String, text: String?): Obligation {
        repeat(maximumAttempts - 1) {
            try {
                return obligations.handOff(fileId, text)
            } catch (checking: StillCheckingException) {
                delay(retryDelayMillis)
            }
        }
        return obligations.handOff(fileId, text)
    }

    private fun format(value: BigDecimal): String =
        (NumberFormat.getNumberInstance(locale) as DecimalFormat).apply {
            isGroupingUsed = false
            maximumFractionDigits = 10
        }.format(value)

    private fun problemFor(failure: Exception): HandoffProblem {
        rejectionMessage = null
        return when (failure) {
            is StillCheckingException -> HandoffProblem.STILL_CHECKING
            is ObligationDismissedException -> HandoffProblem.DISMISSED
            is CaptureRejectedException -> {
                rejectionMessage = failure.message
                HandoffProblem.REJECTED
            }
            is ApiException -> if (failure.status == 404) HandoffProblem.NOT_FOUND else HandoffProblem.GENERIC
            is IOException -> HandoffProblem.OFFLINE
            else -> HandoffProblem.GENERIC
        }
    }

    companion object {
        /** The hand-off route's `text` cap, `OBLIGATION_LIMITS.text` in b4m-core/common schemas/obligation.ts. */
        const val HAND_OFF_TEXT_LIMIT = 20_000

        /** Cuts a long scan to the route's cap instead of failing; never splits a surrogate pair. */
        fun capHandOffText(text: String, limit: Int = HAND_OFF_TEXT_LIMIT): String {
            if (text.length <= limit) return text
            val end = if (Character.isHighSurrogate(text[limit - 1])) limit - 1 else limit
            return text.substring(0, end)
        }

        /** Empty means no amount. Exact: parsed to [BigDecimal], never through a double. */
        fun parseAmount(raw: String, locale: Locale): Result<BigDecimal?> {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return Result.success(null)
            val format = (NumberFormat.getNumberInstance(locale) as DecimalFormat).apply { isParseBigDecimal = true }
            val position = ParsePosition(0)
            val parsed = format.parse(trimmed, position) as? BigDecimal
            if (parsed == null || position.index != trimmed.length) {
                return Result.failure(AmountException(AmountProblem.NOT_A_NUMBER))
            }
            if (parsed.signum() < 0) return Result.failure(AmountException(AmountProblem.NEGATIVE))
            return Result.success(parsed)
        }
    }
}

class AmountException(val problem: AmountProblem) : Exception(problem.name)
