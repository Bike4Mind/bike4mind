package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.app.capture.PickedFile
import com.bike4mind.kit.approvals.PendingActionDecision
import com.bike4mind.kit.capture.readyFileIds
import com.bike4mind.kit.chat.ChatError
import com.bike4mind.kit.chat.ChatState
import com.bike4mind.kit.chat.FailedSend
import com.bike4mind.kit.sessions.PendingAction
import com.bike4mind.kit.sessions.Quest

class ChatViewModel(graph: AppGraph, sessionId: String?) : ViewModel() {
    val controller = graph.chat(sessionId, viewModelScope).also { it.start() }
    val attachments = graph.composerAttachments(viewModelScope)
    val dictation = graph.dictation(viewModelScope)

    override fun onCleared() {
        controller.stop()
        dictation.cancel()
        attachments.clear()
    }
}

/** [composeDraft] non-null (a launcher shortcut) fills the composer and focuses it; nothing is sent until send. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(graph: AppGraph, sessionId: String?, onBack: () -> Unit, composeDraft: String? = null) {
    // Scoped by AppRoot's ScreenScope: cleared (and the controller stopped) when this chat closes.
    val model = viewModel { ChatViewModel(graph, sessionId) }
    val state by model.controller.state.collectAsStateWithLifecycle()
    val attachments by model.attachments.state.collectAsStateWithLifecycle()
    val dictation by model.dictation.state.collectAsStateWithLifecycle()
    var draft by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(caretAtEnd(composeDraft.orEmpty())) }
    // Saved so a rotation does not pull the keyboard back up after the user dismissed it.
    var focusComposer by rememberSaveable { mutableStateOf(composeDraft != null) }
    val composer = remember { FocusRequester() }
    LaunchedEffect(focusComposer) {
        if (focusComposer) {
            composer.requestFocus()
            focusComposer = false
        }
    }
    var problem by remember { mutableStateOf<String?>(null) }
    var offeredScan by remember { mutableStateOf<Pair<PickedFile, String>?>(null) }
    var handoff by remember { mutableStateOf<Pair<PickedFile, String>?>(null) }
    val list = rememberLazyListState()
    val fileIds = attachments.readyFileIds()
    val attachedMessage = stringResource(R.string.capture_attached_message, attachments.joinToString(", ") { it.name })

    val rows = state.turns.size + state.failedSends.size
    LaunchedEffect(rows) {
        if (rows > 0) list.animateScrollToItem(rows - 1)
    }

    DictationDialog(
        state = dictation,
        onDone = { model.dictation.finish { text -> draft = caretAtEnd(if (draft.text.isBlank()) text else "${draft.text} $text") } },
        onCancel = model.dictation::cancel,
        onDismissFailure = model.dictation::dismissFailure,
    )

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (sessionId == null && state.sessionId == null) R.string.chat_title_new else R.string.chat_title)) },
                navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).imePadding()) {
            if (state.loading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            LazyColumn(
                state = list,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(Spacing.m),
            ) {
                items(state.turns, key = { it.id }) { turn ->
                    Turn(turn, state) { action, decision -> model.controller.respond(turn.id, action, decision) }
                }
                items(state.failedSends, key = { it.id }) { failed ->
                    FailedSendRow(failed, retryEnabled = !state.sending) { model.controller.retry(failed.id) }
                }
            }
            state.statusMessage?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = Spacing.m))
            }
            state.error?.let { error ->
                Text(
                    text = when (error) {
                        is ChatError.Refused -> error.message ?: stringResource(R.string.chat_refused, error.errorCode ?: stringResource(R.string.chat_refused_unknown))
                        is ChatError.Failed -> error.message
                    },
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = Spacing.m),
                )
            }
            problem?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = Spacing.m))
            }
            // The agent-executions route takes no files (ChatController refuses the same send).
            val agentRunWithFiles = state.sendsAsAgentRun && attachments.isNotEmpty()
            if (agentRunWithFiles) {
                Text(
                    stringResource(R.string.chat_agent_no_attachments),
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = Spacing.m).testTag("chat-composer-agent-no-attachments"),
                )
            }
            AttachmentList(attachments, onRemove = model.attachments::remove, onRetry = model.attachments::retry)
            Row(
                modifier = Modifier.fillMaxWidth().padding(Spacing.m),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AttachMenu(
                    onPicked = { picked ->
                        problem = null
                        model.attachments.add(picked.file, picked.name, picked.mimeType)
                    },
                    onDictate = {
                        problem = null
                        model.dictation.start()
                    },
                    onProblem = { problem = it },
                    enabled = !state.sending,
                    onScanned = { picked, text -> offeredScan = picked to text },
                )
                // An agent run reports progress in its notification (push/AgentRunNotifications.kt), not here.
                if (model.controller.canStartAgentRun(state)) {
                    FilterChip(
                        selected = state.sendsAsAgentRun,
                        onClick = { model.controller.setSendsAsAgentRun(!state.sendsAsAgentRun) },
                        label = { Text(stringResource(R.string.chat_agent_toggle)) },
                        modifier = Modifier.testTag("chat-composer-agent-toggle"),
                    )
                }
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f).focusRequester(composer).testTag("chat-composer-field"),
                    placeholder = { Text(stringResource(if (state.sendsAsAgentRun) R.string.chat_agent_placeholder else R.string.chat_message_placeholder)) },
                )
                val canSend = !state.sending && !agentRunWithFiles && fileIds != null && (draft.text.isNotBlank() || attachments.isNotEmpty())
                Button(modifier = Modifier.testTag("chat-composer-send"), enabled = canSend, onClick = {
                    // A turn needs words; files sent on their own go out named.
                    val message = draft.text.ifBlank { attachedMessage }
                    val sentFileIds = fileIds.orEmpty()
                    model.controller.send(message, sentFileIds) { model.attachments.clear(sentFileIds) }
                    draft = TextFieldValue()
                }) {
                    Text(stringResource(R.string.chat_send))
                }
            }
        }
    }
    offeredScan?.let { (picked, text) ->
        AlertDialog(
            onDismissRequest = { offeredScan = null },
            title = { Text(stringResource(R.string.capture_handoff_title)) },
            text = { Text(stringResource(R.string.capture_handoff_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        offeredScan = null
                        handoff = picked to text
                    },
                    modifier = Modifier.testTag("capture-handoff-btn"),
                ) { Text(stringResource(R.string.capture_handoff)) }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        offeredScan = null
                        model.attachments.add(picked.file, picked.name, picked.mimeType)
                    },
                    modifier = Modifier.testTag("capture-scan-attach-btn"),
                ) { Text(stringResource(R.string.capture_handoff_attach)) }
            },
        )
    }
    handoff?.let { (picked, text) ->
        val controller = remember(picked) { graph.obligationHandoff() }
        ObligationConfirmSheet(controller, picked.file, text, onClose = { handoff = null })
    }
}

private fun caretAtEnd(text: String) = TextFieldValue(text, TextRange(text.length))

@Composable
private fun FailedSendRow(failed: FailedSend, retryEnabled: Boolean, onRetry: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m).testTag("chat-failed-send")) {
        Card(modifier = Modifier.testTag("message-failed")) { Text(failed.message, modifier = Modifier.padding(Spacing.m)) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(failed.reason?.let { stringResource(R.string.chat_send_failed_reason, it) } ?: stringResource(R.string.chat_send_failed), color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
            TextButton(onClick = onRetry, enabled = retryEnabled, modifier = Modifier.testTag("chat-failed-send-retry-btn")) {
                Text(stringResource(R.string.action_try_again))
            }
        }
    }
}

@Composable
private fun Turn(turn: Quest, chat: ChatState, onRespond: (PendingAction, PendingActionDecision) -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        turn.prompt?.let { prompt ->
            Card(modifier = Modifier.testTag("message-user")) { Text(prompt, modifier = Modifier.padding(Spacing.m)) }
        }
        val reply = turn.reply
        when {
            turn.failed -> Text(turn.errorCode?.let { stringResource(R.string.chat_reply_failed_code, it) } ?: stringResource(R.string.chat_reply_failed), color = MaterialTheme.colorScheme.error)
            reply.isNullOrEmpty() && !turn.status.isTerminal -> Text(stringResource(R.string.chat_reply_pending), style = MaterialTheme.typography.bodyLarge)
            reply != null -> Text(reply, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("message-assistant"))
        }
        turn.pendingAction?.let { action ->
            ApprovalCard(action, chat.approval(turn.id, action)) { decision -> onRespond(action, decision) }
        }
    }
}
