package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.kit.account.AccountDeletionController
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.launch

class AccountRestoreViewModel(graph: AppGraph) : ViewModel() {
    val controller = graph.accountRestore(viewModelScope)
}

/**
 * Covers the app while the account waits to be deleted (any call answered 403 `ACCOUNT_DELETION_PENDING`).
 * Restoring clears the signal and AppRoot returns to the chats list. Twin of apps/ios AccountRestoreView.
 */
@Composable
fun AccountRestoreScreen(graph: AppGraph, scheduledFor: Instant?) {
    val model = viewModel { AccountRestoreViewModel(graph) }
    val state by model.controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(Spacing.l).testTag("restore-screen"),
            verticalArrangement = Arrangement.spacedBy(Spacing.m, Alignment.CenterVertically),
        ) {
            Text(stringResource(R.string.restore_title), style = MaterialTheme.typography.headlineSmall)
            Text(
                if (scheduledFor != null) {
                    val date = DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).format(scheduledFor.atZone(ZoneId.systemDefault()))
                    stringResource(R.string.restore_scheduled_on, date)
                } else {
                    stringResource(R.string.restore_scheduled, AccountDeletionController.GRACE_PERIOD_DAYS)
                },
            )
            Text(stringResource(R.string.restore_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
            state.error?.let { Text(accountErrorText(it), color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = model.controller::restore,
                enabled = !state.restoring,
                modifier = Modifier.fillMaxWidth().testTag("restore-account-btn"),
            ) {
                if (state.restoring) {
                    CircularProgressIndicator(modifier = Modifier.size(Spacing.m), color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Text(stringResource(R.string.restore_action))
                }
            }
            OutlinedButton(
                onClick = { scope.launch { graph.signOut() } },
                enabled = !state.restoring,
                modifier = Modifier.fillMaxWidth().testTag("restore-signout-btn"),
            ) { Text(stringResource(R.string.settings_sign_out)) }
        }
    }
}
