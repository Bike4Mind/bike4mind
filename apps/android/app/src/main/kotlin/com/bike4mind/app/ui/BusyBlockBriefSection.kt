package com.bike4mind.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.bike4mind.app.R
import com.bike4mind.kit.briefs.BusyBlockBriefError
import com.bike4mind.kit.briefs.BusyBlockBriefState

/** Shown while the system allows notifications, or while it is on, so it can always be turned off (apps/ios rule). */
internal fun showsBusyBlockBrief(systemAllowsNotifications: Boolean, state: BusyBlockBriefState) =
    systemAllowsNotifications || state.isEnabled

/** The "Brief after busy blocks" switch in Settings > Notifications. Twin of apps/ios NotificationSettingsView's section. */
@Composable
internal fun BusyBlockBriefSection(state: BusyBlockBriefState, onToggle: (Boolean) -> Unit, onOpenSettings: () -> Unit) {
    Column(modifier = Modifier.testTag("settings-busy-block-brief")) {
        ListItem(
            headlineContent = { Text(stringResource(R.string.settings_busy_block_title)) },
            trailingContent = {
                Switch(
                    checked = state.isEnabled,
                    onCheckedChange = onToggle,
                    enabled = state.isLoaded && !state.isSaving,
                    modifier = Modifier.testTag("settings-busy-block-brief-switch"),
                )
            },
        )
        if (state.isAccessDenied) {
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_busy_block_open_settings)) },
                modifier = Modifier.clickable(onClick = onOpenSettings).testTag("settings-busy-block-open-settings-btn"),
            )
        }
        Text(
            stringResource(footer(state)),
            style = MaterialTheme.typography.bodySmall,
            color = if (state.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Spacing.m).testTag("settings-busy-block-footer"),
        )
    }
}

private fun footer(state: BusyBlockBriefState): Int = when {
    state.error == BusyBlockBriefError.LOAD -> R.string.settings_busy_block_load_failed
    state.error == BusyBlockBriefError.SAVE -> R.string.settings_busy_block_save_failed
    state.isAccessDenied -> R.string.settings_busy_block_denied
    else -> R.string.settings_busy_block_detail
}
