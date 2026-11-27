package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.kit.account.AccountDeletionController
import com.bike4mind.kit.account.AccountDeletionFailure
import com.bike4mind.kit.account.AccountDeletionPhase
import com.bike4mind.kit.account.StepUpController
import com.bike4mind.kit.account.StepUpFailure
import com.bike4mind.kit.account.StepUpMethod
import com.bike4mind.kit.account.StepUpPhase
import com.bike4mind.kit.account.StepUpState

class DeleteAccountViewModel(graph: AppGraph) : ViewModel() {
    val deletion = graph.accountDeletion(viewModelScope)

    // A passed step-up retries the request the gate refused.
    val stepUp = graph.stepUp(viewModelScope) { deletion.submit() }
}

/**
 * Explains what deletion does, takes the typed confirmation, and handles the step-up and "transfer your
 * organizations first" answers. An accepted request signs the app out (AppGraph.endSessionAfterDeletion).
 * Twin of apps/ios DeleteAccountView.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeleteAccountScreen(graph: AppGraph, onBack: () -> Unit) {
    val model = viewModel { DeleteAccountViewModel(graph) }
    val state by model.deletion.state.collectAsStateWithLifecycle()
    var stepUpOpen by rememberSaveable { mutableStateOf(false) }
    val deleting = state.phase is AccountDeletionPhase.Deleting || state.phase is AccountDeletionPhase.Completed

    LaunchedEffect(state.attempt, state.needsStepUp) {
        if (state.needsStepUp) {
            stepUpOpen = true
            model.stepUp.load()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.delete_title)) },
                navigationIcon = { TextButton(onClick = onBack, enabled = !deleting) { Text(stringResource(R.string.action_back)) } },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(Spacing.m),
            verticalArrangement = Arrangement.spacedBy(Spacing.m),
        ) {
            Text(stringResource(R.string.delete_what_happens), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.delete_body))
            Text(stringResource(R.string.delete_grace, AccountDeletionController.GRACE_PERIOD_DAYS))

            (state.phase as? AccountDeletionPhase.Failed)?.failure?.let { FailureNotice(it) }

            OutlinedTextField(
                value = state.confirmation,
                onValueChange = model.deletion::setConfirmation,
                label = { Text(stringResource(R.string.delete_confirm_label, AccountDeletionController.CONFIRMATION_PHRASE)) },
                singleLine = true,
                enabled = !deleting,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().testTag("delete-confirmation-field"),
            )
            Button(
                onClick = model.deletion::submit,
                enabled = state.canSubmit,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth().testTag("delete-account-btn"),
            ) {
                if (deleting) {
                    CircularProgressIndicator(modifier = Modifier.size(Spacing.m), color = MaterialTheme.colorScheme.onError)
                } else {
                    Text(stringResource(R.string.delete_action))
                }
            }
        }
    }

    if (stepUpOpen && state.needsStepUp) {
        StepUpDialog(model.stepUp, onDismiss = { stepUpOpen = false })
    }
}

@Composable
private fun FailureNotice(failure: AccountDeletionFailure) {
    if (failure is AccountDeletionFailure.OrganizationTransferRequired) {
        Column(modifier = Modifier.testTag("delete-organizations"), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Text(stringResource(R.string.delete_transfer_title), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
            Text(stringResource(R.string.delete_transfer_body), style = MaterialTheme.typography.bodyMedium)
            failure.organizations.forEach { organization ->
                Text(
                    organization.name ?: stringResource(R.string.delete_untitled_organization),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(start = Spacing.m),
                )
            }
        }
        return
    }
    val text = when (failure) {
        AccountDeletionFailure.StepUpRequired -> stringResource(R.string.stepup_body)
        AccountDeletionFailure.StepUpUnavailable -> stringResource(R.string.delete_step_up_unavailable)
        AccountDeletionFailure.NotPermitted -> stringResource(R.string.delete_not_permitted)
        AccountDeletionFailure.AlreadyScheduled -> stringResource(R.string.delete_already_scheduled)
        AccountDeletionFailure.Offline -> stringResource(R.string.account_error_offline)
        AccountDeletionFailure.SignedOut -> stringResource(R.string.account_error_signed_out)
        AccountDeletionFailure.UpgradeRequired -> stringResource(R.string.delete_upgrade)
        is AccountDeletionFailure.Server -> stringResource(R.string.delete_server, failure.status)
        is AccountDeletionFailure.OrganizationTransferRequired -> return
    }
    Text(text, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("delete-error"))
}

/** "Confirm it's you": one proof by password, authenticator code or emailed code. Twin of apps/ios StepUpSheet. */
@Composable
private fun StepUpDialog(controller: StepUpController, onDismiss: () -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()

    AlertDialog(
        onDismissRequest = { if (!state.busy) onDismiss() },
        title = { Text(stringResource(R.string.stepup_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.s), modifier = Modifier.testTag("stepup-dialog")) {
                when (val phase = state.phase) {
                    StepUpPhase.Loading, StepUpPhase.Verified -> CircularProgressIndicator()
                    is StepUpPhase.LoadFailed -> Text(accountErrorText(phase.error), color = MaterialTheme.colorScheme.error)
                    StepUpPhase.NoMethodAvailable -> Text(stringResource(R.string.stepup_no_method))
                    StepUpPhase.Ready -> StepUpForm(controller, state)
                }
            }
        },
        confirmButton = {
            when (state.phase) {
                StepUpPhase.Ready -> TextButton(
                    onClick = controller::submit,
                    enabled = state.canSubmit,
                    modifier = Modifier.testTag("stepup-confirm-btn"),
                ) { Text(stringResource(R.string.stepup_confirm)) }
                is StepUpPhase.LoadFailed -> TextButton(onClick = controller::load) { Text(stringResource(R.string.action_try_again)) }
                else -> Unit
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !state.busy) { Text(stringResource(R.string.stepup_cancel)) }
        },
    )
}

@Composable
private fun StepUpForm(controller: StepUpController, state: StepUpState) {
    if (state.methods.size > 1) {
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            state.methods.forEach { method ->
                FilterChip(
                    selected = method == state.selected,
                    onClick = { controller.select(method) },
                    label = { Text(stringResource(methodLabel(method))) },
                    modifier = Modifier.testTag("stepup-method-${method.wire}"),
                )
            }
        }
    }
    when (state.selected) {
        StepUpMethod.PASSWORD -> OutlinedTextField(
            value = state.password,
            onValueChange = controller::setPassword,
            label = { Text(stringResource(R.string.stepup_password)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth().testTag("stepup-password-field"),
        )
        StepUpMethod.TOTP -> CodeField(controller, state, R.string.stepup_totp_code)
        StepUpMethod.EMAIL -> if (state.pendingToken == null) {
            TextButton(onClick = controller::sendEmailCode, enabled = !state.busy, modifier = Modifier.testTag("stepup-send-code-btn")) {
                Text(stringResource(R.string.stepup_send_code))
            }
        } else {
            CodeField(controller, state, R.string.stepup_email_code)
        }
        null -> Unit
    }
    if (state.busy) CircularProgressIndicator(modifier = Modifier.size(Spacing.l))
    state.sendError?.let { Text(accountErrorText(it), color = MaterialTheme.colorScheme.error) }
    state.failure?.let { Text(stepUpFailureText(it), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("stepup-error")) }
}

@Composable
private fun CodeField(controller: StepUpController, state: StepUpState, label: Int) {
    OutlinedTextField(
        value = state.code,
        onValueChange = controller::setCode,
        label = { Text(stringResource(label)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth().testTag("stepup-code-field"),
    )
}

private fun methodLabel(method: StepUpMethod): Int = when (method) {
    StepUpMethod.PASSWORD -> R.string.stepup_method_password
    StepUpMethod.TOTP -> R.string.stepup_method_totp
    StepUpMethod.EMAIL -> R.string.stepup_method_email
}

@Composable
private fun stepUpFailureText(failure: StepUpFailure): String = when (failure) {
    is StepUpFailure.Rejected -> {
        val base = failure.message ?: stringResource(R.string.stepup_rejected)
        val remaining = failure.attemptsRemaining
        if (remaining != null && remaining > 0) {
            pluralStringResource(R.plurals.stepup_attempts_remaining, remaining, base, remaining)
        } else {
            base
        }
    }
    StepUpFailure.RateLimited -> stringResource(R.string.account_error_rate_limited)
    StepUpFailure.SessionEnded -> stringResource(R.string.stepup_session_ended)
    StepUpFailure.Offline -> stringResource(R.string.account_error_offline)
    StepUpFailure.UpgradeRequired -> stringResource(R.string.delete_upgrade)
    is StepUpFailure.Server -> stringResource(R.string.account_error_server)
}
