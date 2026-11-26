package com.bike4mind.app.share

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bike4mind.app.B4MApplication
import com.bike4mind.app.R
import com.bike4mind.app.ui.Spacing
import com.bike4mind.kit.capture.CaptureDestination
import com.bike4mind.kit.sessions.SessionSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val NEW_CHAT = ""

/** Choose New chat or a recent chat, add a message, send. Sending only queues; CaptureWorker delivers. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareScreen(app: B4MApplication, content: SharedContent, onSent: () -> Unit, onOpenApp: () -> Unit, onCancel: () -> Unit) {
    val graph = app.graph.collectAsStateWithLifecycle().value ?: return
    val signedIn by graph.session.isSignedIn.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var restored by remember(graph) { mutableStateOf(false) }
    var chats by remember { mutableStateOf<List<SessionSummary>?>(null) }
    var chatsFailed by remember { mutableStateOf(false) }
    var chosen by rememberSaveable { mutableStateOf(NEW_CHAT) }
    var note by rememberSaveable { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var readFailed by remember { mutableStateOf(false) }
    val attached = stringResource(R.string.capture_attached_message, content.files.joinToString(", ") { it.name })

    LaunchedEffect(graph) {
        graph.session.restore()
        restored = true
    }
    LaunchedEffect(graph, signedIn) {
        if (!signedIn) return@LaunchedEffect
        try {
            chats = graph.sessions.list().sessions
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            chatsFailed = true
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.share_title)) },
                navigationIcon = { TextButton(onClick = onCancel) { Text(stringResource(R.string.share_cancel)) } },
                actions = {
                    TextButton(
                        modifier = Modifier.testTag("share-send-btn"),
                        enabled = signedIn && !sending && !content.isEmpty,
                        onClick = {
                            sending = true
                            readFailed = false
                            val destination = if (chosen == NEW_CHAT) {
                                CaptureDestination.NewChat
                            } else {
                                CaptureDestination.Session(chosen, chats?.firstOrNull { it.id == chosen }?.title)
                            }
                            val message = listOf(note.trim(), content.text.orEmpty()).filter { it.isNotEmpty() }
                                .joinToString("\n\n").ifEmpty { attached }
                            scope.launch {
                                try {
                                    withContext(Dispatchers.IO) { graph.capture.enqueue(destination, message, content.files) }
                                    onSent()
                                } catch (cancelled: CancellationException) {
                                    throw cancelled
                                } catch (error: Exception) {
                                    sending = false
                                    readFailed = true
                                }
                            }
                        },
                    ) { Text(stringResource(R.string.share_send)) }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal = Spacing.m),
            verticalArrangement = Arrangement.spacedBy(Spacing.m),
        ) {
            when {
                !restored -> LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                !signedIn -> {
                    Text(stringResource(R.string.share_signed_out))
                    Button(onClick = onOpenApp) { Text(stringResource(R.string.share_open_app)) }
                }
                content.isEmpty -> Text(stringResource(R.string.share_nothing))
                else -> {
                    content.text?.let { Text(it, maxLines = 4, style = MaterialTheme.typography.bodyMedium) }
                    if (content.files.isNotEmpty()) {
                        Text(
                            pluralStringResource(R.plurals.share_files, content.files.size, content.files.size) + ": " +
                                content.files.joinToString(", ") { it.name },
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 3,
                        )
                    }
                    if (readFailed) Text(stringResource(R.string.share_read_failed), color = MaterialTheme.colorScheme.error)
                    OutlinedTextField(
                        value = note,
                        onValueChange = { note = it },
                        label = { Text(stringResource(R.string.share_note_label)) },
                        modifier = Modifier.fillMaxWidth().testTag("share-note-field"),
                    )
                    Text(stringResource(R.string.share_destination), style = MaterialTheme.typography.titleSmall)
                    if (chatsFailed) Text(stringResource(R.string.share_chats_failed), color = MaterialTheme.colorScheme.error)
                    if (chats == null && !chatsFailed) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
                        item(key = NEW_CHAT) {
                            DestinationRow(stringResource(R.string.share_new_chat), chosen == NEW_CHAT, "share-destination-new") { chosen = NEW_CHAT }
                        }
                        items(chats.orEmpty(), key = { it.id }) { chat ->
                            DestinationRow(chat.title, chosen == chat.id, "share-destination-chat") { chosen = chat.id }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DestinationRow(label: String, selected: Boolean, tag: String, onSelect: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().selectable(selected = selected, onClick = onSelect, role = Role.RadioButton)
            .padding(vertical = Spacing.xs).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(label, maxLines = 1)
    }
}
