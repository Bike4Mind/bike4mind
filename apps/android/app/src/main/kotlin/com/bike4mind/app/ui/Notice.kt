package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign

/** A full-screen message (loading failed, nothing here yet) with an optional single action. */
@Composable
internal fun Notice(
    title: String,
    body: String?,
    tag: String,
    action: Pair<String, () -> Unit>? = null,
    actionTag: String? = null,
) {
    Centered(tag = tag) {
        Column(
            modifier = Modifier.padding(Spacing.l),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Spacing.m),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            body?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            action?.let { (label, onClick) ->
                OutlinedButton(onClick = onClick, modifier = actionTag?.let { Modifier.testTag(it) } ?: Modifier) { Text(label) }
            }
        }
    }
}

@Composable
internal fun Centered(tag: String, content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize().testTag(tag), contentAlignment = Alignment.Center) { content() }
}
