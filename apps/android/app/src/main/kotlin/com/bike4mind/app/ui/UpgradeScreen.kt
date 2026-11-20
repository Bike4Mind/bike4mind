package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.bike4mind.app.R
import kotlinx.coroutines.launch

/** Shown while the server answers 426 (upgrade required) to this build. */
@Composable
fun UpgradeScreen(minimumVersion: String?, recheck: suspend () -> Unit) {
    val scope = rememberCoroutineScope()
    var checking by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(Spacing.l),
        verticalArrangement = Arrangement.spacedBy(Spacing.m, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.upgrade_title), style = MaterialTheme.typography.headlineSmall)
        Text(
            text = minimumVersion?.let { stringResource(R.string.upgrade_body_version, it) }
                ?: stringResource(R.string.upgrade_body),
            textAlign = TextAlign.Center,
        )
        Button(enabled = !checking, onClick = {
            scope.launch {
                checking = true
                try {
                    recheck()
                } finally {
                    checking = false
                }
            }
        }) {
            Text(stringResource(R.string.action_try_again))
        }
    }
}
