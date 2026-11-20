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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.kit.approvals.PendingActionDecision
import com.bike4mind.kit.chat.ChatError
import com.bike4mind.kit.chat.ChatState
import com.bike4mind.kit.sessions.PendingAction
import com.bike4mind.kit.sessions.Quest

class ChatViewModel(graph: AppGraph, sessionId: String?) : ViewModel() {
    val controller = graph.chat(sessionId, viewModelScope).also { it.start() }

    override fun onCleared() {
        controller.stop()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(graph: AppGraph, sessionId: String?, onBack: () -> Unit) {
    // Scoped by AppRoot's ScreenScope: cleared (and the controller stopped) when this chat closes.
    val model = viewModel { ChatViewModel(graph, sessionId) }
    val state by model.controller.state.collectAsStateWithLifecycle()
    var draft by rememberSaveable { mutableStateOf("") }
    val list = rememberLazyListState()

    LaunchedEffect(state.turns.size) {
        if (state.turns.isNotEmpty()) list.animateScrollToItem(state.turns.lastIndex)
    }

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
            Row(
                modifier = Modifier.fillMaxWidth().padding(Spacing.m),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f).testTag("chat-composer-field"),
                    placeholder = { Text(stringResource(R.string.chat_message_placeholder)) },
                )
                Button(modifier = Modifier.testTag("chat-composer-send"), enabled = draft.isNotBlank() && !state.sending, onClick = {
                    model.controller.send(draft)
                    draft = ""
                }) {
                    Text(stringResource(R.string.chat_send))
                }
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
        turn.pendingAction?.takeUnless { turn.status.isTerminal }?.let { action ->
            ApprovalCard(action, chat.approval(turn.id, action)) { decision -> onRespond(action, decision) }
        }
    }
}
