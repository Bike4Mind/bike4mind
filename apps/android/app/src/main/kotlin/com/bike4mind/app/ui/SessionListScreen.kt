package com.bike4mind.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.kit.networking.UpgradeRequiredException
import com.bike4mind.kit.sessions.SessionSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SessionListState(
    val sessions: List<SessionSummary> = emptyList(),
    val nextCursor: String? = null,
    val loading: Boolean = false,
    /** The server message of a failed load, if it sent one; the screen shows a generic one otherwise. */
    val error: String? = null,
    val loadFailed: Boolean = false,
    /** The user's default model from client-config; null until it loads (or when it could not). */
    val defaultModel: String? = null,
)

class SessionListViewModel(private val graph: AppGraph) : ViewModel() {
    private val mutableState = MutableStateFlow(SessionListState())
    val state: StateFlow<SessionListState> = mutableState.asStateFlow()

    init {
        refresh()
        viewModelScope.launch {
            val model = try {
                graph.clientConfig().models.defaultId
            } catch (upgrade: UpgradeRequiredException) {
                null
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                null
            }
            mutableState.update { it.copy(defaultModel = model) }
        }
    }

    fun refresh() = load(cursor = null)

    fun loadMore() {
        val cursor = state.value.nextCursor ?: return
        load(cursor)
    }

    private fun load(cursor: String?) {
        if (state.value.loading) return
        mutableState.update { it.copy(loading = true, error = null, loadFailed = false) }
        viewModelScope.launch {
            try {
                val page = graph.sessions.list(cursor)
                mutableState.update {
                    it.copy(
                        sessions = if (cursor == null) page.sessions else it.sessions + page.sessions,
                        nextCursor = page.nextCursor,
                        loading = false,
                    )
                }
            } catch (upgrade: UpgradeRequiredException) {
                mutableState.update { it.copy(loading = false) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                mutableState.update { it.copy(loading = false, error = failure.message, loadFailed = true) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    graph: AppGraph,
    onOpen: (String) -> Unit,
    onNewChat: () -> Unit,
    onOpenBrief: () -> Unit,
    onOpenStudio: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    // Scoped by AppRoot's ScreenScope: a sign-out clears it, so the next account never sees this list.
    val model = viewModel { SessionListViewModel(graph) }
    val state by model.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.sessions_title)) },
                actions = {
                    TextButton(onClick = onOpenBrief, modifier = Modifier.testTag("sessions-brief-btn")) { Text(stringResource(R.string.sessions_brief)) }
                    TextButton(onClick = onOpenStudio, modifier = Modifier.testTag("sessions-studio-btn")) { Text(stringResource(R.string.sessions_studio)) }
                    TextButton(onClick = model::refresh) { Text(stringResource(R.string.action_refresh)) }
                    TextButton(onClick = onOpenSettings, modifier = Modifier.testTag("sessions-settings-btn")) { Text(stringResource(R.string.sessions_settings)) }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = onNewChat, modifier = Modifier.testTag("sessions-new-conversation-btn")) { Text(stringResource(R.string.sessions_new_chat)) }
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(modifier = Modifier.fillMaxSize().testTag("sessions-list")) {
                item(key = "pending-shares") { PendingShares(graph) }
                state.defaultModel?.let { defaultModel ->
                    item {
                        Text(
                            text = stringResource(R.string.sessions_default_model, defaultModel),
                            style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.padding(horizontal = Spacing.m, vertical = Spacing.s),
                        )
                    }
                }
                if (state.loadFailed) {
                    item {
                        Text(state.error ?: stringResource(R.string.sessions_load_failed), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(Spacing.m))
                    }
                }
                items(state.sessions, key = { it.id }) { session ->
                    ListItem(
                        headlineContent = { Text(session.title, maxLines = 1) },
                        supportingContent = session.lastUsedModel?.let { usedModel -> { Text(usedModel, maxLines = 1) } },
                        modifier = Modifier.fillMaxWidth().clickable { onOpen(session.id) },
                    )
                    HorizontalDivider()
                }
                if (state.nextCursor != null) {
                    item {
                        LaunchedEffect(state.sessions.size) { model.loadMore() }
                    }
                }
            }
            if (state.loading && state.sessions.isEmpty()) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            }
        }
    }
}
