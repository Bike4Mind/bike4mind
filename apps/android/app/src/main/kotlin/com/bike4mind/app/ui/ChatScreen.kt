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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.kit.chat.ChatError
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
                title = { Text(if (sessionId == null && state.sessionId == null) "New chat" else "Chat") },
                navigationIcon = { TextButton(onClick = onBack) { Text("Back") } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).imePadding()) {
            if (state.loading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            LazyColumn(
                state = list,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.turns, key = { it.id }) { turn -> Turn(turn) }
            }
            state.statusMessage?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 16.dp))
            }
            state.error?.let { error ->
                Text(
                    text = when (error) {
                        is ChatError.Refused -> error.message ?: "The message was refused (${error.errorCode ?: "unknown"})"
                        is ChatError.Failed -> error.message
                    },
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Message") },
                )
                Button(enabled = draft.isNotBlank() && !state.sending, onClick = {
                    model.controller.send(draft)
                    draft = ""
                }) {
                    Text("Send")
                }
            }
        }
    }
}

@Composable
private fun Turn(turn: Quest) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        turn.prompt?.let { prompt ->
            Card { Text(prompt, modifier = Modifier.padding(12.dp)) }
        }
        val reply = turn.reply
        when {
            turn.failed -> Text("The reply failed${turn.errorCode?.let { " ($it)" } ?: ""}.", color = MaterialTheme.colorScheme.error)
            reply.isNullOrEmpty() && !turn.status.isTerminal -> Text("...", style = MaterialTheme.typography.bodyLarge)
            reply != null -> Text(reply, style = MaterialTheme.typography.bodyLarge)
        }
    }
}
