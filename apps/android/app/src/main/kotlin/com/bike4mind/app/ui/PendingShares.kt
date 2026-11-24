package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.app.capture.CaptureWorker
import com.bike4mind.kit.capture.CaptureDestination
import com.bike4mind.kit.capture.CaptureFailure
import com.bike4mind.kit.capture.CaptureStage
import kotlinx.coroutines.launch

/** Shares from other apps that are still on their way, and the ones that failed with Retry and Discard. */
@Composable
fun PendingShares(graph: AppGraph) {
    val jobs by graph.capture.jobs.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(graph) { graph.capture.load() }
    val pending = jobs.count { it.stage == CaptureStage.PENDING }
    val failed = jobs.filter { it.stage == CaptureStage.FAILED }
    if (pending == 0 && failed.isEmpty()) return

    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        if (pending > 0) {
            Text(pluralStringResource(R.plurals.shares_sending, pending, pending), style = MaterialTheme.typography.labelMedium)
        }
        failed.forEach { job ->
            Card(modifier = Modifier.fillMaxWidth().testTag("pending-share-failed")) {
                Column(modifier = Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    val destination = when (val target = job.destination) {
                        is CaptureDestination.Session -> target.name ?: stringResource(R.string.chat_title)
                        CaptureDestination.NewChat -> stringResource(R.string.share_new_chat)
                    }
                    Text(stringResource(R.string.share_failed_to, destination, captureFailureText(job.lastFailure ?: CaptureFailure.Failed)))
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                        TextButton(onClick = {
                            scope.launch {
                                graph.capture.retry(job.id)
                                CaptureWorker.schedule(context)
                            }
                        }) { Text(stringResource(R.string.share_retry)) }
                        TextButton(onClick = { scope.launch { graph.capture.discard(job.id) } }) {
                            Text(stringResource(R.string.share_discard))
                        }
                    }
                }
            }
        }
    }
}
