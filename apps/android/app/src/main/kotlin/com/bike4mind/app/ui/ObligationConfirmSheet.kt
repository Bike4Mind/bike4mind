package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bike4mind.app.R
import com.bike4mind.kit.obligations.AmountException
import com.bike4mind.kit.obligations.AmountProblem
import com.bike4mind.kit.obligations.HandoffPhase
import com.bike4mind.kit.obligations.HandoffProblem
import com.bike4mind.kit.obligations.ObligationHandoffController
import java.io.File
import kotlinx.coroutines.launch

/**
 * "Hand to assistant" for a scanned bill: shows what the assistant read and lets the user correct it before
 * confirming, which files the scan into the chosen lake so the brief can remind them before it is due.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ObligationConfirmSheet(controller: ObligationHandoffController, scan: File, text: String, onClose: () -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LaunchedEffect(controller) {
        if (state.phase == HandoffPhase.UPLOADING) controller.start(scan, text)
    }
    ModalBottomSheet(onDismissRequest = { if (state.phase != HandoffPhase.SAVING) onClose() }) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(Spacing.m).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Text(stringResource(R.string.obligation_title), style = MaterialTheme.typography.titleMedium)
            when (state.phase) {
                HandoffPhase.UPLOADING, HandoffPhase.EXTRACTING -> Row(
                    horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator()
                    Text(
                        stringResource(
                            if (state.phase == HandoffPhase.UPLOADING) R.string.obligation_uploading else R.string.obligation_reading,
                        ),
                    )
                }
                HandoffPhase.FAILED -> {
                    Text(problemText(state.problem, controller.rejectionMessage), color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = onClose, modifier = Modifier.testTag("obligation-close-btn")) {
                        Text(stringResource(R.string.obligation_close))
                    }
                }
                HandoffPhase.DONE -> {
                    Text(stringResource(R.string.obligation_saved))
                    TextButton(onClick = onClose, modifier = Modifier.testTag("obligation-close-btn")) {
                        Text(stringResource(R.string.obligation_close))
                    }
                }
                HandoffPhase.REVIEWING, HandoffPhase.SAVING -> {
                    val editable = state.phase == HandoffPhase.REVIEWING
                    state.obligation?.summary?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    val amountProblem = (controller.parsedAmount.exceptionOrNull() as? AmountException)?.problem
                    OutlinedTextField(
                        value = state.amountText,
                        onValueChange = { value -> controller.edit { it.copy(amountText = value) } },
                        label = { Text(stringResource(R.string.obligation_amount, state.currency)) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        isError = amountProblem != null,
                        supportingText = if (amountProblem == null) {
                            null
                        } else {
                            {
                                Text(
                                    stringResource(
                                        if (amountProblem == AmountProblem.NEGATIVE) {
                                            R.string.obligation_amount_negative
                                        } else {
                                            R.string.obligation_amount_invalid
                                        },
                                    ),
                                )
                            }
                        },
                        enabled = editable,
                        modifier = Modifier.fillMaxWidth().testTag("obligation-amount-field"),
                    )
                    OutlinedTextField(
                        value = state.payee,
                        onValueChange = { value -> controller.edit { it.copy(payee = value) } },
                        label = { Text(stringResource(R.string.obligation_payee)) },
                        enabled = editable,
                        modifier = Modifier.fillMaxWidth().testTag("obligation-payee-field"),
                    )
                    OutlinedTextField(
                        value = state.dueDate ?: "",
                        onValueChange = { value -> controller.edit { it.copy(dueDate = value.trim().ifEmpty { null }) } },
                        label = { Text(stringResource(R.string.obligation_due_date)) },
                        enabled = editable,
                        modifier = Modifier.fillMaxWidth().testTag("obligation-due-field"),
                    )
                    Text(stringResource(R.string.obligation_destination), style = MaterialTheme.typography.labelLarge)
                    Column(modifier = Modifier.testTag("obligation-destination-picker")) {
                        DestinationRow(stringResource(R.string.obligation_no_destination), state.destinationLakeId == null, editable) {
                            controller.edit { it.copy(destinationLakeId = null) }
                        }
                        state.lakes.forEach { lake ->
                            DestinationRow(lake.name, state.destinationLakeId == lake.id, editable) {
                                controller.edit { it.copy(destinationLakeId = lake.id) }
                            }
                        }
                    }
                    if (state.problem != null) {
                        Text(
                            problemText(state.problem, controller.rejectionMessage),
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.testTag("obligation-save-error"),
                        )
                    }
                    Button(
                        onClick = { scope.launch { controller.confirm() } },
                        enabled = controller.canConfirm,
                        modifier = Modifier.fillMaxWidth().testTag("obligation-confirm-btn"),
                    ) {
                        Text(stringResource(R.string.obligation_confirm))
                    }
                }
            }
        }
    }
}

@Composable
private fun DestinationRow(name: String, selected: Boolean, enabled: Boolean, onSelect: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = selected, onClick = onSelect, enabled = enabled)
        Text(name)
    }
}

@Composable
private fun problemText(problem: HandoffProblem?, rejection: String?): String = when (problem) {
    HandoffProblem.REJECTED -> rejection ?: stringResource(R.string.obligation_problem_generic)
    HandoffProblem.NOT_FOUND -> stringResource(R.string.obligation_problem_not_found)
    HandoffProblem.STILL_CHECKING -> stringResource(R.string.obligation_problem_checking)
    HandoffProblem.DISMISSED -> stringResource(R.string.obligation_problem_dismissed)
    HandoffProblem.OFFLINE -> stringResource(R.string.obligation_problem_offline)
    HandoffProblem.GENERIC, null -> stringResource(R.string.obligation_problem_generic)
}
