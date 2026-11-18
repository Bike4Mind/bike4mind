package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.kit.briefs.Brief
import com.bike4mind.kit.briefs.BriefDecision
import com.bike4mind.kit.briefs.BriefItem
import com.bike4mind.kit.briefs.BriefState
import com.bike4mind.kit.briefs.BriefStatus
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

class BriefViewModel(graph: AppGraph, briefId: String?) : ViewModel() {
    val controller = graph.brief(briefId, viewModelScope).also { it.load() }
}

/**
 * The assistant brief, opened from a `brief_ready` push ([briefId]) or from the chats list (null: the latest).
 * What needs the user comes first; an approval opens the chat that holds the existing approval card
 * ([onOpenSession]). Twin of apps/ios Features/Brief/BriefView.swift.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BriefScreen(graph: AppGraph, briefId: String?, onBack: () -> Unit, onOpenSession: (String) -> Unit) {
    // Scoped by AppRoot's ScreenScope: leaving the brief cancels a poll in flight.
    val model = viewModel(key = briefId) { BriefViewModel(graph, briefId) }
    val controller = model.controller
    val state by controller.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Brief") },
                navigationIcon = { TextButton(onClick = onBack, modifier = Modifier.testTag("brief-back-btn")) { Text("Back") } },
                actions = { TextButton(onClick = controller::load, modifier = Modifier.testTag("brief-refresh-btn")) { Text("Refresh") } },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            val brief = state.brief
            when {
                state.loading && brief == null -> Centered(tag = "brief-loading") { CircularProgressIndicator() }
                brief == null && state.error != null -> Message(
                    title = "Couldn't load the brief",
                    body = state.error,
                    action = "Try again" to controller::load,
                    tag = "brief-error",
                    actionTag = "brief-retry-btn",
                )
                brief == null -> Message(
                    title = "No brief yet",
                    body = "Your assistant can summarize what happened, what it handled and what needs you.",
                    action = "Compose a brief" to controller::compose,
                    tag = "brief-empty",
                    actionTag = "brief-compose-btn",
                )
                else -> BriefContent(brief, state, onCompose = controller::compose, onOpenSession = onOpenSession)
            }
        }
    }
}

@Composable
private fun BriefContent(brief: Brief, state: BriefState, onCompose: () -> Unit, onOpenSession: (String) -> Unit) {
    when (brief.status) {
        BriefStatus.COMPOSING -> if (state.composeTimedOut) {
            Message(
                title = "Still working on it",
                body = "This is taking longer than usual. Refresh to check again.",
                tag = "brief-composing",
            )
        } else {
            Centered(tag = "brief-composing") {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator()
                    Text("Putting your brief together")
                }
            }
        }
        BriefStatus.FAILED -> Message(
            title = "The brief didn't finish",
            body = "Something went wrong while putting it together.",
            action = "Try again" to onCompose,
            tag = "brief-failed",
            actionTag = "brief-failed-retry-btn",
        )
        BriefStatus.UNKNOWN -> Message(
            title = "Update to read this brief",
            body = "This brief needs a newer version of Bike4Mind.",
            tag = "brief-unsupported",
        )
        BriefStatus.READY -> if (brief.isEmpty) {
            Message(
                title = "All quiet",
                body = "Nothing needs you right now.",
                action = "Compose a brief" to onCompose,
                tag = "brief-empty",
                actionTag = "brief-compose-btn",
            )
        } else {
            Ready(brief, state.error, onOpenSession)
        }
    }
}

@Composable
private fun Ready(brief: Brief, error: String?, onOpenSession: (String) -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("brief-content"),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            brief.headline?.takeIf { it.isNotEmpty() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.semantics { heading() }.testTag("brief-headline"),
                )
            }
            brief.periodStart?.let {
                Text(
                    "Since " + PERIOD_FORMAT.format(it.atZone(ZoneId.systemDefault())),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (brief.decisions.isNotEmpty()) {
            Section("What needs you", tag = "brief-decisions-section") {
                brief.decisions.forEach { Decision(it, onOpenSession) }
            }
        }
        Items("Handled", brief.handled, tag = "brief-handled-section")
        Items("What happened", brief.happened, tag = "brief-happened-section")
    }
}

@Composable
private fun Decision(decision: BriefDecision, onOpenSession: (String) -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().testTag("brief-decision-row")) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(decision.text, style = MaterialTheme.typography.bodyLarge)
            decision.approval?.let { approval ->
                // The chat holds the existing approval card; the brief does not rebuild it.
                Button(
                    onClick = { onOpenSession(approval.sessionId) },
                    modifier = Modifier.testTag("brief-open-approval-btn"),
                ) { Text("Open approval") }
            }
        }
    }
}

@Composable
private fun Items(title: String, items: List<BriefItem>, tag: String) {
    if (items.isEmpty()) return
    Section(title, tag) {
        items.forEach {
            Text(it.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.fillMaxWidth().testTag("brief-item-row"))
        }
    }
}

@Composable
private fun Section(title: String, tag: String, content: @Composable () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().testTag(tag), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
        content()
    }
}

@Composable
private fun Centered(tag: String, content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize().testTag(tag), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun Message(
    title: String,
    body: String?,
    tag: String,
    action: Pair<String, () -> Unit>? = null,
    actionTag: String? = null,
) {
    Centered(tag = tag) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
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

private val PERIOD_FORMAT: DateTimeFormatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
