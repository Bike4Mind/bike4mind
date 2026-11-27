package com.bike4mind.kit.account

import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.UpgradeRequiredException
import com.bike4mind.kit.push.NotificationCategory
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** A failed account call, reduced to what the screen says about it. */
enum class AccountCallError { OFFLINE, SIGNED_OUT, RATE_LIMITED, SERVER }

/** Runs [block]; a failure becomes an [AccountCallError], and a 426 null (the upgrade screen covers the app). */
internal suspend fun <T> accountCall(block: suspend () -> T): Result<T>? = try {
    Result.success(block())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (upgrade: UpgradeRequiredException) {
    null
} catch (failure: Exception) {
    Result.failure(AccountCallException(errorFor(failure)))
}

internal class AccountCallException(val error: AccountCallError) : Exception(error.name)

internal fun errorFor(failure: Throwable): AccountCallError = when {
    failure is AccountCallException -> failure.error
    failure is IOException -> AccountCallError.OFFLINE
    failure is ApiException && failure.status == 401 -> AccountCallError.SIGNED_OUT
    failure is ApiException && failure.status == 429 -> AccountCallError.RATE_LIMITED
    else -> AccountCallError.SERVER
}

internal val Throwable.accountError: AccountCallError get() = errorFor(this)

data class SettingsState(
    val loading: Boolean = true,
    val profile: AccountProfile? = null,
    val loadError: AccountCallError? = null,
    /** Set when the last switch change could not be saved; the switch is back where it was. */
    val saveError: AccountCallError? = null,
) {
    fun isEnabled(category: NotificationCategory): Boolean = profile?.isEnabled(category) ?: true
}

/**
 * The Settings screen: the profile header and one switch per push category, saved to the server so the
 * server-side sender honors it. A switch moves at once and moves back if the save fails. Twin of apps/ios
 * NotificationSettingsViewModel, which still stores the switches on the device only.
 */
class SettingsController(private val api: AccountApi, private val scope: CoroutineScope) {
    private val mutableState = MutableStateFlow(SettingsState())
    val state: StateFlow<SettingsState> = mutableState.asStateFlow()

    // Saves for one category run in tap order, and only the latest tap rolls back, to the last value the server accepted.
    private val taps = mutableMapOf<NotificationCategory, Int>()
    private val accepted = mutableMapOf<NotificationCategory, Boolean?>()
    private val saving = NotificationCategory.entries.associateWith { Mutex() }

    fun load() {
        mutableState.update { it.copy(loading = true, loadError = null) }
        scope.launch {
            val result = accountCall { api.profile() }
            mutableState.update {
                it.copy(
                    loading = false,
                    profile = result?.getOrNull() ?: it.profile,
                    loadError = result?.exceptionOrNull()?.accountError,
                )
            }
        }
    }

    fun setEnabled(category: NotificationCategory, enabled: Boolean) {
        val profile = state.value.profile ?: return
        if (profile.isEnabled(category) == enabled) return
        if (category !in accepted) accepted[category] = profile.pushPreferences[category]
        val tap = (taps[category] ?: 0) + 1
        taps[category] = tap
        setPreference(category, enabled)
        mutableState.update { it.copy(saveError = null) }
        scope.launch {
            val failure = saving.getValue(category).withLock { accountCall { api.setPushCategory(category, enabled) } }
                ?.exceptionOrNull()
            if (failure == null) {
                accepted[category] = enabled
            } else if (taps[category] == tap) {
                setPreference(category, accepted[category])
                mutableState.update { it.copy(saveError = failure.accountError) }
            }
        }
    }

    private fun setPreference(category: NotificationCategory, value: Boolean?) = mutableState.update { state ->
        val profile = state.profile ?: return@update state
        val preferences = if (value == null) profile.pushPreferences - category else profile.pushPreferences + (category to value)
        state.copy(profile = profile.copy(pushPreferences = preferences))
    }
}

sealed interface AccountDeletionPhase {
    data object Idle : AccountDeletionPhase
    data object Deleting : AccountDeletionPhase

    /** The request went through; the app is signing out. */
    data class Completed(val scheduledFor: Instant?) : AccountDeletionPhase
    data class Failed(val failure: AccountDeletionFailure) : AccountDeletionPhase
}

data class AccountDeletionState(
    val confirmation: String = "",
    val phase: AccountDeletionPhase = AccountDeletionPhase.Idle,
    /** Counts requests, so the screen can tell a repeated identical answer (step-up again) from the last one. */
    val attempt: Int = 0,
) {
    val isConfirmed: Boolean get() = confirmation.trim() == AccountDeletionController.CONFIRMATION_PHRASE

    val canSubmit: Boolean
        get() = isConfirmed && phase !is AccountDeletionPhase.Deleting && phase !is AccountDeletionPhase.Completed

    /** The server wants a step-up first: the screen collects one, then calls submit again. */
    val needsStepUp: Boolean get() = (phase as? AccountDeletionPhase.Failed)?.failure == AccountDeletionFailure.StepUpRequired
}

/**
 * The Delete account screen: the typed confirmation, the request, and the step-up and "transfer your
 * organizations first" branches. [endSession] runs only after the server accepted the request, and must sign
 * the app out locally (the server has already revoked every session). Twin of apps/ios AccountDeletionViewModel.
 */
class AccountDeletionController(
    private val api: AccountApi,
    private val scope: CoroutineScope,
    private val endSession: suspend () -> Unit,
) {
    private val mutableState = MutableStateFlow(AccountDeletionState())
    val state: StateFlow<AccountDeletionState> = mutableState.asStateFlow()

    fun setConfirmation(text: String) = mutableState.update { it.copy(confirmation = text) }

    fun submit() {
        if (!state.value.canSubmit) return
        mutableState.update { it.copy(phase = AccountDeletionPhase.Deleting, attempt = it.attempt + 1) }
        scope.launch {
            when (val outcome = api.requestDeletion()) {
                is AccountDeletionOutcome.Scheduled -> {
                    mutableState.update { it.copy(phase = AccountDeletionPhase.Completed(outcome.scheduledFor)) }
                    endSession()
                }
                is AccountDeletionOutcome.Failed ->
                    mutableState.update { it.copy(phase = AccountDeletionPhase.Failed(outcome.failure)) }
            }
        }
    }

    companion object {
        /** The word the user types to arm the button, matching the web app and iOS. */
        const val CONFIRMATION_PHRASE = "DELETE"
        const val GRACE_PERIOD_DAYS = 30
    }
}

sealed interface StepUpPhase {
    data object Loading : StepUpPhase
    data class LoadFailed(val error: AccountCallError) : StepUpPhase

    /** The account has no method this app can collect (a passkey-only user, say). */
    data object NoMethodAvailable : StepUpPhase
    data object Ready : StepUpPhase
    data object Verified : StepUpPhase
}

data class StepUpState(
    val phase: StepUpPhase = StepUpPhase.Loading,
    val methods: List<StepUpMethod> = emptyList(),
    val selected: StepUpMethod? = null,
    val password: String = "",
    val code: String = "",
    /** Set once an emailed code is on its way; the code field replaces the "Send code" button. */
    val pendingToken: String? = null,
    val sendingCode: Boolean = false,
    val submitting: Boolean = false,
    val sendError: AccountCallError? = null,
    val failure: StepUpFailure? = null,
) {
    val busy: Boolean get() = sendingCode || submitting

    val canSubmit: Boolean
        get() = phase == StepUpPhase.Ready && !busy && when (selected) {
            StepUpMethod.PASSWORD -> password.isNotEmpty()
            StepUpMethod.TOTP -> code.isNotBlank()
            StepUpMethod.EMAIL -> pendingToken != null && code.isNotBlank()
            null -> false
        }
}

/**
 * The "Confirm it's you" step: loads the usable methods, collects one proof, then calls [onVerified] so the
 * caller retries what the step-up gate refused. [onSessionEnded] runs when the server ended the session (too
 * many wrong passwords). Twin of apps/ios StepUpViewModel.
 */
class StepUpController(
    private val api: StepUpApi,
    private val scope: CoroutineScope,
    private val now: () -> Instant = Instant::now,
    private val onVerified: () -> Unit,
    private val onSessionEnded: suspend () -> Unit,
) {
    private val mutableState = MutableStateFlow(StepUpState())
    val state: StateFlow<StepUpState> = mutableState.asStateFlow()

    fun load() {
        mutableState.value = StepUpState()
        scope.launch {
            val result = accountCall { api.options() } ?: return@launch
            val options = result.getOrElse { failure ->
                mutableState.update { it.copy(phase = StepUpPhase.LoadFailed(failure.accountError)) }
                return@launch
            }
            // An open window means the gate would already pass: nothing to prove.
            if (options.stepUpUntil?.isAfter(now()) == true) {
                mutableState.update { it.copy(phase = StepUpPhase.Verified) }
                onVerified()
                return@launch
            }
            mutableState.update {
                it.copy(
                    phase = if (options.methods.isEmpty()) StepUpPhase.NoMethodAvailable else StepUpPhase.Ready,
                    methods = options.methods,
                    selected = options.methods.firstOrNull(),
                )
            }
        }
    }

    fun select(method: StepUpMethod) = mutableState.update {
        if (method !in it.methods || method == it.selected) it
        else it.copy(selected = method, password = "", code = "", failure = null, sendError = null)
    }

    fun setPassword(value: String) = mutableState.update { it.copy(password = value) }

    fun setCode(value: String) = mutableState.update { it.copy(code = value) }

    fun sendEmailCode() {
        val current = state.value
        if (current.phase != StepUpPhase.Ready || current.busy) return
        mutableState.update { it.copy(sendingCode = true, sendError = null, failure = null) }
        scope.launch {
            val result = accountCall { api.sendEmailCode() }
            mutableState.update {
                it.copy(
                    sendingCode = false,
                    pendingToken = result?.getOrNull() ?: it.pendingToken,
                    code = if (result?.isSuccess == true) "" else it.code,
                    sendError = result?.exceptionOrNull()?.accountError,
                )
            }
        }
    }

    fun submit() {
        val current = state.value
        if (!current.canSubmit) return
        val proof = when (current.selected) {
            StepUpMethod.PASSWORD -> StepUpProof.Password(current.password)
            StepUpMethod.TOTP -> StepUpProof.Totp(current.code.trim())
            StepUpMethod.EMAIL -> StepUpProof.Email(current.pendingToken ?: return, current.code.trim())
            null -> return
        }
        mutableState.update { it.copy(submitting = true, failure = null) }
        scope.launch {
            when (val outcome = api.verify(proof)) {
                is StepUpOutcome.Verified -> {
                    mutableState.update { it.copy(submitting = false, phase = StepUpPhase.Verified, password = "", code = "") }
                    onVerified()
                }
                is StepUpOutcome.Failed -> {
                    // A password is never worth keeping after a rejection; a code can be corrected in place.
                    mutableState.update { it.copy(submitting = false, failure = outcome.failure, password = "") }
                    if (outcome.failure == StepUpFailure.SessionEnded) onSessionEnded()
                }
            }
        }
    }
}

data class AccountRestoreState(val restoring: Boolean = false, val error: AccountCallError? = null)

/** The restore screen shown while the account waits to be deleted. Twin of apps/ios AccountRestoreViewModel. */
class AccountRestoreController(
    private val api: AccountApi,
    private val scope: CoroutineScope,
    private val onRestored: () -> Unit,
) {
    private val mutableState = MutableStateFlow(AccountRestoreState())
    val state: StateFlow<AccountRestoreState> = mutableState.asStateFlow()

    fun restore() {
        if (state.value.restoring) return
        mutableState.value = AccountRestoreState(restoring = true)
        scope.launch {
            val result = accountCall { api.restoreDeletion() }
            mutableState.value = AccountRestoreState(error = result?.exceptionOrNull()?.accountError)
            if (result?.isSuccess == true) onRestored()
        }
    }
}
