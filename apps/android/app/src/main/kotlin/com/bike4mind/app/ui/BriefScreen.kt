package com.bike4mind.app.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.kit.briefs.Brief
import com.bike4mind.kit.briefs.BriefDecision
import com.bike4mind.kit.briefs.BriefDecisionEdit
import com.bike4mind.kit.briefs.BriefDecisionOutcome
import com.bike4mind.kit.briefs.BriefDraftReply
import com.bike4mind.kit.briefs.BriefFollowUp
import com.bike4mind.kit.briefs.BriefItem
import com.bike4mind.kit.briefs.BriefState
import com.bike4mind.kit.briefs.BriefStatus
import com.bike4mind.kit.briefs.FollowUpKind
import com.bike4mind.kit.briefs.FollowUpState
import com.bike4mind.kit.briefs.mailtoUri
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

class BriefViewModel(graph: AppGraph, briefId: String?) : ViewModel() {
    val controller = graph.brief(briefId, viewModelScope).also { it.load() }
    val dictation = graph.dictation(viewModelScope)

    // Cancelling viewModelScope stops transcription but not the recorder; only cancel() releases the mic.
    override fun onCleared() {
        dictation.cancel()
    }
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
    val dictation by model.dictation.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var problem by remember { mutableStateOf<String?>(null) }
    val permissionDenied = stringResource(R.string.dictation_failed_permission)
    val microphone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) model.dictation.start() else problem = permissionDenied
    }
    val noMailApp = stringResource(R.string.brief_followup_no_mail_app)
    val handOff: (BriefDraftReply) -> Unit = { draft ->
        try {
            context.startActivity(mailIntent(draft))
        } catch (missing: ActivityNotFoundException) {
            problem = noMailApp
        }
    }

    DictationDialog(
        state = dictation,
        onDone = { model.dictation.finish(controller::startFollowUp) },
        onCancel = model.dictation::cancel,
        onDismissFailure = model.dictation::dismissFailure,
    )
    problem?.let { message ->
        AlertDialog(
            onDismissRequest = { problem = null },
            confirmButton = { TextButton(onClick = { problem = null }) { Text(stringResource(R.string.brief_followup_ok)) } },
            text = { Text(message) },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.brief_title)) },
                navigationIcon = { TextButton(onClick = onBack, modifier = Modifier.testTag("brief-back-btn")) { Text(stringResource(R.string.action_back)) } },
                actions = {
                    TextButton(
                        onClick = {
                            val allowed = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                            if (allowed) model.dictation.start() else microphone.launch(Manifest.permission.RECORD_AUDIO)
                        },
                        enabled = !state.composing,
                        modifier = Modifier.testTag("brief-followup-dictate-btn"),
                    ) { Text(stringResource(R.string.brief_followup_dictate)) }
                    TextButton(onClick = controller::load, modifier = Modifier.testTag("brief-refresh-btn")) { Text(stringResource(R.string.action_refresh)) }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            val brief = state.brief
            when {
                state.loading && brief == null -> Centered(tag = "brief-loading") { CircularProgressIndicator() }
                brief == null && state.error != null -> Notice(
                    title = stringResource(R.string.brief_load_failed),
                    body = state.error,
                    action = stringResource(R.string.action_try_again) to controller::load,
                    tag = "brief-error",
                    actionTag = "brief-retry-btn",
                )
                brief == null -> Notice(
                    title = stringResource(R.string.brief_empty_title),
                    body = stringResource(R.string.brief_empty_body),
                    action = stringResource(R.string.brief_compose) to controller::compose,
                    tag = "brief-empty",
                    actionTag = "brief-compose-btn",
                )
                else -> BriefContent(
                    brief,
                    state,
                    onCompose = controller::compose,
                    onLoad = controller::load,
                    onOpenSession = onOpenSession,
                    followUps = FollowUpActions(
                        busy = state.followUpBusy,
                        errors = state.followUpErrors,
                        onResolve = { decision, outcome -> controller.resolveFollowUp(decision, outcome, handOff) },
                        onEdit = { decision, edit, onSaved -> controller.editFollowUp(decision, edit, onSaved) },
                        onOpenMail = handOff,
                    ),
                )
            }
        }
    }
}

@Composable
private fun BriefContent(
    brief: Brief,
    state: BriefState,
    onCompose: () -> Unit,
    onLoad: () -> Unit,
    onOpenSession: (String) -> Unit,
    followUps: FollowUpActions,
) {
    when (brief.status) {
        BriefStatus.COMPOSING -> if (state.error != null) {
            Notice(
                title = stringResource(R.string.brief_load_failed),
                body = state.error,
                action = stringResource(R.string.action_try_again) to onLoad,
                tag = "brief-error",
                actionTag = "brief-retry-btn",
            )
        } else if (state.composeTimedOut) {
            Notice(
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
        BriefStatus.FAILED -> Notice(
            title = stringResource(R.string.brief_failed_title),
            body = stringResource(R.string.brief_failed_body),
            action = stringResource(R.string.action_try_again) to onCompose,
            tag = "brief-failed",
            actionTag = "brief-failed-retry-btn",
        )
        BriefStatus.UNKNOWN -> Notice(
            title = stringResource(R.string.brief_unsupported_title),
            body = stringResource(R.string.brief_unsupported_body),
            tag = "brief-unsupported",
        )
        BriefStatus.READY -> if (brief.isEmpty) {
            Notice(
                title = stringResource(R.string.brief_quiet_title),
                body = stringResource(R.string.brief_quiet_body),
                action = stringResource(R.string.brief_compose) to onCompose,
                tag = "brief-empty",
                actionTag = "brief-compose-btn",
            )
        } else {
            Ready(brief, state.error, onOpenSession, followUps)
        }
    }
}

@Composable
private fun Ready(brief: Brief, error: String?, onOpenSession: (String) -> Unit, followUps: FollowUpActions) {
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
                brief.decisions.forEach { Decision(it, onOpenSession, followUps) }
            }
        }
        Items(stringResource(R.string.brief_handled), brief.handled, tag = "brief-handled-section")
        Items(stringResource(R.string.brief_happened), brief.happened, tag = "brief-happened-section")
    }
}

@Composable
private fun Decision(decision: BriefDecision, onOpenSession: (String) -> Unit, followUps: FollowUpActions) {
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
            decision.followUp?.let { FollowUpControls(decision, it, followUps) }
        }
    }
}

/** Follow-up callbacks and per-decision request state, threaded from the screen down to each decision card. */
private class FollowUpActions(
    val busy: Set<String>,
    val errors: Map<String, String>,
    val onResolve: (BriefDecision, BriefDecisionOutcome) -> Unit,
    val onEdit: (BriefDecision, BriefDecisionEdit, () -> Unit) -> Unit,
    val onOpenMail: (BriefDraftReply) -> Unit,
)

@Composable
private fun FollowUpControls(decision: BriefDecision, followUp: BriefFollowUp, actions: FollowUpActions) {
    var editing by remember(decision.id) { mutableStateOf(false) }
    val detail = when (followUp.kind) {
        FollowUpKind.ACTION_ITEM -> stringResource(R.string.brief_followup_action_item)
        FollowUpKind.FOLLOW_UP_EMAIL -> stringResource(R.string.brief_followup_email)
        FollowUpKind.REMINDER -> followUp.remindAt?.let {
            stringResource(R.string.brief_followup_reminder_at, PERIOD_FORMAT.format(it.atZone(ZoneId.systemDefault())))
        } ?: stringResource(R.string.brief_followup_reminder_unset)
        FollowUpKind.UNKNOWN -> null
    }
    detail?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("brief-followup-kind")) }
    val draft = decision.draftReply
    if (followUp.kind == FollowUpKind.FOLLOW_UP_EMAIL && draft != null) {
        Column(modifier = Modifier.testTag("brief-followup-draft"), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Text(stringResource(R.string.brief_followup_to, draft.to), style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.brief_followup_subject, draft.subject), style = MaterialTheme.typography.bodyMedium)
            Text(draft.body, style = MaterialTheme.typography.bodyMedium, maxLines = 6)
        }
    }
    if (followUp.isActionable) {
        actions.errors[decision.id]?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("brief-followup-error")) }
        if (decision.id in actions.busy) {
            CircularProgressIndicator(modifier = Modifier.testTag("brief-followup-progress"))
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Button(onClick = { actions.onResolve(decision, BriefDecisionOutcome.APPROVE) }, modifier = Modifier.testTag("brief-followup-approve-btn")) {
                    Text(stringResource(R.string.brief_followup_approve))
                }
                OutlinedButton(onClick = { editing = true }, modifier = Modifier.testTag("brief-followup-edit-btn")) {
                    Text(stringResource(R.string.brief_followup_edit))
                }
                OutlinedButton(onClick = { actions.onResolve(decision, BriefDecisionOutcome.DISMISS) }, modifier = Modifier.testTag("brief-followup-dismiss-btn")) {
                    Text(stringResource(R.string.brief_followup_dismiss))
                }
            }
        }
    } else {
        val label = when (followUp.state) {
            FollowUpState.APPROVED -> stringResource(R.string.brief_followup_approved)
            FollowUpState.DISMISSED -> stringResource(R.string.brief_followup_dismissed)
            FollowUpState.PENDING, FollowUpState.UNKNOWN -> null
        }
        label?.let { Text(it, style = MaterialTheme.typography.labelMedium, modifier = Modifier.testTag("brief-followup-state")) }
        // Approval is recorded before the mail handoff, so a draft the mail app never opened can still be sent.
        if (followUp.state == FollowUpState.APPROVED && followUp.kind == FollowUpKind.FOLLOW_UP_EMAIL && draft != null) {
            OutlinedButton(onClick = { actions.onOpenMail(draft) }, modifier = Modifier.testTag("brief-followup-open-mail-btn")) {
                Text(stringResource(R.string.brief_followup_open_mail))
            }
        }
    }
    // A 409 refetch can settle the follow-up under an open dialog; there is nothing left to save then.
    if (editing && followUp.isActionable) {
        FollowUpEditDialog(
            decision = decision,
            saving = decision.id in actions.busy,
            error = actions.errors[decision.id],
            onSave = { edit -> actions.onEdit(decision, edit) { editing = false } },
            onDismiss = { editing = false },
        )
    }
}

/**
 * Hands an approved draft to the device mail app. Bike4Mind never sends it. Subject and body ride in the mailto URI
 * too, since many mail apps ignore the extras on ACTION_SENDTO.
 */
private fun mailIntent(draft: BriefDraftReply): Intent {
    return Intent(Intent.ACTION_SENDTO, Uri.parse(draft.mailtoUri())).apply {
        putExtra(Intent.EXTRA_SUBJECT, draft.subject)
        putExtra(Intent.EXTRA_TEXT, draft.body)
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

private val PERIOD_FORMAT: DateTimeFormatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
