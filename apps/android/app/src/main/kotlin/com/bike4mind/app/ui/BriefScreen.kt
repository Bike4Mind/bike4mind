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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
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
                title = { Text(stringResource(R.string.brief_title)) },
                navigationIcon = { TextButton(onClick = onBack, modifier = Modifier.testTag("brief-back-btn")) { Text(stringResource(R.string.action_back)) } },
                actions = { TextButton(onClick = controller::load, modifier = Modifier.testTag("brief-refresh-btn")) { Text(stringResource(R.string.action_refresh)) } },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            val brief = state.brief
            when {
                state.loading && brief == null -> Centered(tag = "brief-loading") { CircularProgressIndicator() }
                brief == null && state.error != null -> Message(
                    title = stringResource(R.string.brief_load_failed),
                    body = state.error,
                    action = stringResource(R.string.action_try_again) to controller::load,
                    tag = "brief-error",
                    actionTag = "brief-retry-btn",
                )
                brief == null -> Message(
                    title = stringResource(R.string.brief_empty_title),
                    body = stringResource(R.string.brief_empty_body),
                    action = stringResource(R.string.brief_compose) to controller::compose,
                    tag = "brief-empty",
                    actionTag = "brief-compose-btn",
                )
                else -> BriefContent(brief, state, onCompose = controller::compose, onLoad = controller::load, onOpenSession = onOpenSession)
            }
        }
    }
}

@Composable
private fun BriefContent(brief: Brief, state: BriefState, onCompose: () -> Unit, onLoad: () -> Unit, onOpenSession: (String) -> Unit) {
    when (brief.status) {
        BriefStatus.COMPOSING -> if (state.error != null) {
            Message(
                title = stringResource(R.string.brief_load_failed),
                body = state.error,
                action = stringResource(R.string.action_try_again) to onLoad,
                tag = "brief-error",
                actionTag = "brief-retry-btn",
            )
        } else if (state.composeTimedOut) {
            Message(
                title = stringResource(R.string.brief_timed_out_title),
                body = stringResource(R.string.brief_timed_out_body),
                tag = "brief-composing",
            )
        } else {
            Centered(tag = "brief-composing") {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                    CircularProgressIndicator()
                    Text(stringResource(R.string.brief_composing))
                }
            }
        }
        BriefStatus.FAILED -> Message(
            title = stringResource(R.string.brief_failed_title),
            body = stringResource(R.string.brief_failed_body),
            action = stringResource(R.string.action_try_again) to onCompose,
            tag = "brief-failed",
            actionTag = "brief-failed-retry-btn",
        )
        BriefStatus.UNKNOWN -> Message(
            title = stringResource(R.string.brief_unsupported_title),
            body = stringResource(R.string.brief_unsupported_body),
            tag = "brief-unsupported",
        )
        BriefStatus.READY -> if (brief.isEmpty) {
            Message(
                title = stringResource(R.string.brief_quiet_title),
                body = stringResource(R.string.brief_quiet_body),
                action = stringResource(R.string.brief_compose) to onCompose,
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
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Spacing.m).testTag("brief-content"),
        verticalArrangement = Arrangement.spacedBy(Spacing.l),
    ) {
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
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
                    stringResource(R.string.brief_since, PERIOD_FORMAT.format(it.atZone(ZoneId.systemDefault()))),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (brief.decisions.isNotEmpty()) {
            Section(stringResource(R.string.brief_decisions), tag = "brief-decisions-section") {
                brief.decisions.forEach { Decision(it, onOpenSession) }
            }
        }
        Items(stringResource(R.string.brief_handled), brief.handled, tag = "brief-handled-section")
        Items(stringResource(R.string.brief_happened), brief.happened, tag = "brief-happened-section")
    }
}

@Composable
private fun Decision(decision: BriefDecision, onOpenSession: (String) -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().testTag("brief-decision-row")) {
        Column(modifier = Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Text(decision.text, style = MaterialTheme.typography.bodyLarge)
            decision.approval?.let { approval ->
                // The chat holds the existing approval card; the brief does not rebuild it.
                Button(
                    onClick = { onOpenSession(approval.sessionId) },
                    modifier = Modifier.testTag("brief-open-approval-btn"),
                ) { Text(stringResource(R.string.brief_open_approval)) }
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
    Column(modifier = Modifier.fillMaxWidth().testTag(tag), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
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

private val PERIOD_FORMAT: DateTimeFormatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
