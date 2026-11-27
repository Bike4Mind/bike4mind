package com.bike4mind.app.ui

import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.kit.artifacts.ArtifactError
import com.bike4mind.kit.artifacts.ArtifactListState
import com.bike4mind.kit.artifacts.ArtifactSummary
import com.bike4mind.kit.artifacts.ArtifactType

class ArtifactListViewModel(graph: AppGraph) : ViewModel() {
    val controller = graph.artifactList(viewModelScope).also { it.load() }
}

/**
 * The user's own artifacts, newest first, with an open-and-render detail screen. Read-only. Twin of apps/ios
 * Features/Artifacts. Only reachable while `features.artifacts` is on (see SessionListScreen).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArtifactListScreen(graph: AppGraph, onBack: () -> Unit) {
    // Scoped by AppRoot's ScreenScope: a sign-out clears it with everything else the account saw.
    val model = viewModel { ArtifactListViewModel(graph) }
    val controller = model.controller
    val state by controller.state.collectAsStateWithLifecycle()
    // Saved so a rotation keeps the open artifact; its controller is the detail screen's own view model.
    var openId by rememberSaveable { mutableStateOf<String?>(null) }

    openId?.let { id ->
        BackHandler { openId = null }
        ArtifactDetailScreen(graph = graph, id = id, onBack = { openId = null })
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.artifacts_title)) },
                navigationIcon = { TextButton(onClick = onBack, modifier = Modifier.testTag("artifacts-back-btn")) { Text(stringResource(R.string.action_back)) } },
            )
        },
    ) { padding ->
        ArtifactListContent(
            state = state,
            onRefresh = controller::refresh,
            onLoadMore = controller::loadMore,
            onRetryLoadMore = controller::retryLoadMore,
            onOpen = { openId = it },
            modifier = Modifier.padding(padding),
        )
    }
}

/** The list's states, apart from the controller so previews and tests can draw each one. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ArtifactListContent(
    state: ArtifactListState,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onRetryLoadMore: () -> Unit,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier.fillMaxSize()) {
        val error = state.error
        when {
            state.items.isEmpty() && state.loading -> Centered(tag = "artifacts-loading") {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                    CircularProgressIndicator()
                    Text(stringResource(R.string.artifacts_loading))
                }
            }
            state.items.isEmpty() && error != null -> Notice(
                title = stringResource(R.string.artifacts_load_failed),
                body = errorMessage(error),
                tag = "artifacts-error",
                action = if (error.isRetryable) stringResource(R.string.action_try_again) to onRefresh else null,
                actionTag = "artifacts-retry-btn",
            )
            state.items.isEmpty() && state.loaded -> Notice(
                title = stringResource(R.string.artifacts_empty_title),
                body = stringResource(R.string.artifacts_empty_body),
                tag = "artifacts-empty",
            )
            else -> PullToRefreshBox(isRefreshing = state.loading, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
                LazyColumn(modifier = Modifier.fillMaxSize().testTag("artifacts-list")) {
                    items(state.items, key = { it.id }) { artifact ->
                        ArtifactRow(artifact, onClick = { onOpen(artifact.id) })
                        HorizontalDivider()
                    }
                    if (state.loadingMore) {
                        item(key = "loading-more") {
                            Box(modifier = Modifier.fillMaxWidth().padding(Spacing.m), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                        }
                    }
                    if (error != null) {
                        item(key = "load-more-failed") {
                            Column(
                                modifier = Modifier.fillMaxWidth().padding(Spacing.m).testTag("artifacts-load-more-error"),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(Spacing.s),
                            ) {
                                Text(errorMessage(error))
                                if (error.isRetryable) OutlinedButton(onClick = onRetryLoadMore) { Text(stringResource(R.string.action_try_again)) }
                            }
                        }
                    }
                    if (state.canLoadMore) {
                        item(key = "load-more") { LaunchedEffect(state.items.size) { onLoadMore() } }
                    }
                }
            }
        }
    }
}

@Composable
private fun ArtifactRow(artifact: ArtifactSummary, onClick: () -> Unit) {
    val type = typeLabel(artifact.type)
    val updated = stringResource(R.string.artifacts_updated, relativeTime(artifact))
    val description = stringResource(R.string.artifacts_row_description, artifact.title, type)
    ListItem(
        headlineContent = { Text(artifact.title, maxLines = 1) },
        supportingContent = { Text("$type - $updated", maxLines = 1) },
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics { contentDescription = description }
            .testTag("artifacts-row-${artifact.id}"),
    )
}

private fun relativeTime(artifact: ArtifactSummary): CharSequence =
    DateUtils.getRelativeTimeSpanString(artifact.updatedAt.toEpochMilli(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)

@Composable
internal fun typeLabel(type: ArtifactType): String = stringResource(
    when (type) {
        ArtifactType.HTML -> R.string.artifacts_type_html
        ArtifactType.SVG -> R.string.artifacts_type_svg
        ArtifactType.MERMAID -> R.string.artifacts_type_mermaid
        ArtifactType.CODE -> R.string.artifacts_type_code
        ArtifactType.PYTHON -> R.string.artifacts_type_python
        ArtifactType.FILE -> R.string.artifacts_type_file
        ArtifactType.BLOG_DRAFT -> R.string.artifacts_type_blog_draft
        ArtifactType.REACT -> R.string.artifacts_type_react
        ArtifactType.RECHARTS -> R.string.artifacts_type_recharts
        ArtifactType.LATTICE -> R.string.artifacts_type_lattice
        ArtifactType.CHESS -> R.string.artifacts_type_chess
        ArtifactType.QUEST, ArtifactType.QUESTMASTER, ArtifactType.UNKNOWN -> R.string.artifacts_type_other
    },
)

@Composable
internal fun errorMessage(error: ArtifactError): String = when (error) {
    ArtifactError.Offline -> stringResource(R.string.artifacts_error_offline)
    ArtifactError.NotFound -> stringResource(R.string.artifacts_error_not_found)
    ArtifactError.RateLimited -> stringResource(R.string.artifacts_error_rate_limited)
    is ArtifactError.Server -> stringResource(R.string.artifacts_error_server, error.status)
}
