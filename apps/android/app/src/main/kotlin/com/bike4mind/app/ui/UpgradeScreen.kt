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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Shown while the server answers 426 (upgrade required) to this build. */
@Composable
fun UpgradeScreen(minimumVersion: String?, recheck: suspend () -> Unit) {
    val scope = rememberCoroutineScope()
    var checking by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Update required", style = MaterialTheme.typography.headlineSmall)
        Text(
            text = minimumVersion?.let { "This version of Bike4Mind is no longer supported. Version $it or later is required." }
                ?: "This version of Bike4Mind is no longer supported. Please install the latest version.",
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
            Text("Try again")
        }
    }
}
