package com.bike4mind.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.kit.account.AccountCallError
import com.bike4mind.kit.account.AccountDeletionController
import com.bike4mind.kit.credits.CreditsController
import com.bike4mind.kit.credits.CreditsState
import com.bike4mind.kit.push.NotificationCategory
import kotlinx.coroutines.launch

class SettingsViewModel(graph: AppGraph) : ViewModel() {
    val controller = graph.settings(viewModelScope).also { it.load() }
    val credits = graph.credits(viewModelScope).also { it.load() }
    val busyBlocks = graph.busyBlockBrief(viewModelScope).also { it.load() }
}

/** The profile header, a switch per push category, sign out and the way to account deletion. Twin of apps/ios SettingsView. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(graph: AppGraph, onBack: () -> Unit, onDeleteAccount: () -> Unit) {
    val model = viewModel { SettingsViewModel(graph) }
    val state by model.controller.state.collectAsStateWithLifecycle()
    val credits by model.credits.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var systemAllows by remember { mutableStateOf(NotificationManagerCompat.from(context).areNotificationsEnabled()) }
    val busyBlocks by model.busyBlocks.state.collectAsStateWithLifecycle()
    val calendarPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        model.busyBlocks.setEnabled(true, accessGranted = granted)
    }
    val toggleBusyBlocks: (Boolean) -> Unit = { on ->
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
        if (!on || granted) {
            model.busyBlocks.setEnabled(on, accessGranted = granted)
        } else {
            // Read by CalendarBusyBlockReader.access(): once asked, a missing grant means denied, not undecided.
            graph.busyBlockPermissions.markRequested()
            calendarPermission.launch(Manifest.permission.READ_CALENDAR)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
            )
        },
    ) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding).testTag("settings-list")) {
            item {
                ProfileHeader(
                    name = state.profile?.displayName,
                    email = state.profile?.email,
                    initial = state.profile?.initial,
                    loading = state.loading && state.profile == null,
                )
            }
            state.loadError?.let { error ->
                item {
                    Row(modifier = Modifier.padding(horizontal = Spacing.m), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            stringResource(R.string.settings_load_failed) + " " + accountErrorText(error),
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = model.controller::load) { Text(stringResource(R.string.action_try_again)) }
                    }
                }
            }

            item { SectionHeader(stringResource(R.string.settings_notifications)) }
            item {
                Text(
                    stringResource(R.string.settings_notifications_intro),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.m),
                )
            }
            if (!systemAllows) {
                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.settings_notifications_off)) },
                        supportingContent = { Text(stringResource(R.string.settings_notifications_open_system)) },
                        modifier = Modifier.clickable {
                            context.startActivity(
                                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                            )
                        }.testTag("settings-notifications-system-btn"),
                    )
                }
            }
            if (showsBusyBlockBrief(systemAllows, busyBlocks)) {
                item {
                    BusyBlockBriefSection(
                        state = busyBlocks,
                        onToggle = toggleBusyBlocks,
                        onOpenSettings = {
                            context.startActivity(
                                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
                            )
                        },
                    )
                }
            }
            state.saveError?.let { error ->
                item {
                    Text(
                        stringResource(R.string.settings_save_failed) + " " + accountErrorText(error),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = Spacing.m, vertical = Spacing.xs),
                    )
                }
            }
            items(NotificationCategory.entries, key = { it.wire }) { category ->
                val (title, detail) = categoryText(category)
                ListItem(
                    headlineContent = { Text(stringResource(title)) },
                    supportingContent = { Text(stringResource(detail)) },
                    trailingContent = {
                        Switch(
                            checked = state.isEnabled(category),
                            onCheckedChange = { model.controller.setEnabled(category, it) },
                            enabled = state.profile != null,
                            modifier = Modifier.testTag("settings-notification-${category.wire}-switch"),
                        )
                    },
                )
            }

            item { SectionHeader(stringResource(R.string.settings_account)) }
            item { CreditsRow(credits, onRetry = model.credits::load) }
            item {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.settings_sign_out)) },
                    supportingContent = { Text(stringResource(R.string.settings_server, graph.environment.baseUrl)) },
                    modifier = Modifier.clickable { scope.launch { graph.signOut() } }.testTag("settings-signout-btn"),
                )
            }
            item { HorizontalDivider() }
            item {
                ListItem(
                    headlineContent = {
                        Text(stringResource(R.string.settings_delete_account), color = MaterialTheme.colorScheme.error)
                    },
                    supportingContent = {
                        Text(stringResource(R.string.settings_delete_account_detail, AccountDeletionController.GRACE_PERIOD_DAYS))
                    },
                    modifier = Modifier.clickable(onClick = onDeleteAccount).testTag("settings-delete-account-btn"),
                )
            }
        }
    }

    // Coming back from the system settings page re-reads whether notifications are allowed.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        systemAllows = NotificationManagerCompat.from(context).areNotificationsEnabled()
    }
}

@Composable
private fun ProfileHeader(name: String?, email: String?, initial: String?, loading: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(Spacing.m).testTag("settings-profile"),
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(AVATAR_SIZE).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(Spacing.l))
            } else {
                Text(initial.orEmpty(), style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
            }
        }
        Column {
            name?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
            email?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@Composable
private fun CreditsRow(state: CreditsState, onRetry: () -> Unit) {
    val balance = state.balance
    val error = state.error.takeIf { balance == null }
    ListItem(
        headlineContent = { Text(stringResource(R.string.settings_credits)) },
        supportingContent = error?.let { { Text(accountErrorText(it), color = MaterialTheme.colorScheme.error) } },
        trailingContent = {
            when {
                balance != null -> Text(
                    CreditsController.formatted(balance),
                    style = MaterialTheme.typography.bodyLarge.copy(fontFeatureSettings = "tnum"),
                    modifier = Modifier.testTag("settings-credits-balance"),
                )
                error != null -> TextButton(onClick = onRetry, modifier = Modifier.testTag("settings-credits-retry-btn")) {
                    Text(stringResource(R.string.action_try_again))
                }
                state.loading -> CircularProgressIndicator(modifier = Modifier.size(Spacing.l))
            }
        },
        modifier = Modifier.testTag("settings-credits-row"),
    )
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = Spacing.m, end = Spacing.m, top = Spacing.l, bottom = Spacing.s),
    )
}

private fun categoryText(category: NotificationCategory): Pair<Int, Int> = when (category) {
    NotificationCategory.AGENT_COMPLETED -> R.string.category_agent_completed_title to R.string.category_agent_completed_detail
    NotificationCategory.AGENT_FAILED -> R.string.category_agent_failed_title to R.string.category_agent_failed_detail
    NotificationCategory.APPROVAL_NEEDED -> R.string.category_approval_needed_title to R.string.category_approval_needed_detail
    NotificationCategory.CHAT_COMPLETED -> R.string.category_chat_completed_title to R.string.category_chat_completed_detail
    NotificationCategory.GENERATION_READY -> R.string.category_generation_ready_title to R.string.category_generation_ready_detail
    NotificationCategory.AGENT_MESSAGE -> R.string.category_agent_message_title to R.string.category_agent_message_detail
    NotificationCategory.BRIEF_READY -> R.string.category_brief_ready_title to R.string.category_brief_ready_detail
}

@Composable
internal fun accountErrorText(error: AccountCallError): String = stringResource(
    when (error) {
        AccountCallError.OFFLINE -> R.string.account_error_offline
        AccountCallError.SIGNED_OUT -> R.string.account_error_signed_out
        AccountCallError.RATE_LIMITED -> R.string.account_error_rate_limited
        AccountCallError.SERVER -> R.string.account_error_server
    },
)

private val AVATAR_SIZE = 56.dp
