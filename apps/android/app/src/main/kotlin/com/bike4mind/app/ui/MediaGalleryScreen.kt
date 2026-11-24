package com.bike4mind.app.ui

import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.app.media.MediaImageLoader
import com.bike4mind.kit.media.MediaDetailController
import com.bike4mind.kit.media.MediaError
import com.bike4mind.kit.media.MediaGalleryState
import com.bike4mind.kit.media.MediaItem
import com.bike4mind.kit.media.MediaKind
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow

class MediaGalleryViewModel(private val graph: AppGraph) : ViewModel() {
    val controller = graph.mediaGallery(viewModelScope).also { it.load() }

    /**
     * The file open full screen. Here rather than in the composition so it survives rotation; each open gets a
     * fresh controller, cancelled on close, so a reopened file checks its URL again and never reopens on an old error.
     */
    val openDetail = MutableStateFlow<MediaDetailController?>(null)
    private var detailJob: Job? = null

    fun open(item: MediaItem) {
        close()
        val job = SupervisorJob(viewModelScope.coroutineContext[Job])
        detailJob = job
        openDetail.value = graph.mediaDetail(item, CoroutineScope(viewModelScope.coroutineContext + job)).also { it.prepare() }
    }

    fun close() {
        detailJob?.cancel()
        detailJob = null
        openDetail.value = null
    }
}

/**
 * The Studio gallery (code name: media): a grid of the user's generated images, video and audio, filterable by
 * kind, newest first, drawn stale-first from the last page seen. Viewer only; creating media is a separate
 * feature. Twin of apps/ios Features/Media/MediaGalleryView.swift.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MediaGalleryScreen(graph: AppGraph, onBack: () -> Unit) {
    // Scoped by AppRoot's ScreenScope: a sign-out clears it with everything else the account saw.
    val model = viewModel { MediaGalleryViewModel(graph) }
    val controller = model.controller
    val state by controller.state.collectAsStateWithLifecycle()
    val openDetail by model.openDetail.collectAsStateWithLifecycle()
    // Hoisted above the detail branch so closing a file returns to the same scroll position.
    val gridState = rememberLazyGridState()

    openDetail?.let { detail ->
        BackHandler(onBack = model::close)
        MediaDetailScreen(graph = graph, controller = detail, onBack = model::close)
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.media_title)) },
                navigationIcon = { TextButton(onClick = onBack, modifier = Modifier.testTag("media-back-btn")) { Text(stringResource(R.string.action_back)) } },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            KindFilter(selected = state.kind, onSelect = controller::select)
            Box(modifier = Modifier.fillMaxSize()) {
                when {
                    state.items.isEmpty() && (state.loading || state.loadingMore) -> Centered(tag = "media-loading") {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                            CircularProgressIndicator()
                            Text(stringResource(R.string.media_loading))
                        }
                    }
                    state.items.isEmpty() && state.error != null -> {
                        val error = state.error
                        Notice(
                            title = stringResource(R.string.media_load_failed),
                            body = error?.let { errorMessage(it) },
                            tag = "media-error",
                            action = if (error?.isRetryable == true) stringResource(R.string.action_try_again) to controller::refresh else null,
                            actionTag = "media-retry-btn",
                        )
                    }
                    state.items.isEmpty() -> Notice(
                        title = stringResource(R.string.media_empty_title),
                        body = emptyMessage(state.kind),
                        tag = "media-empty",
                        action = stringResource(R.string.action_refresh) to controller::refresh,
                        actionTag = "media-empty-refresh-btn",
                    )
                    else -> PullToRefreshBox(
                        isRefreshing = state.refreshing,
                        onRefresh = controller::refresh,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        Grid(state, gridState, graph.mediaImages, onOpen = model::open, onRetry = controller::refresh, onLoadMore = controller::loadMore, onNear = controller::loadMoreIfNeeded)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun KindFilter(selected: MediaKind?, onSelect: (MediaKind?) -> Unit) {
    val options = listOf<MediaKind?>(null) + MediaKind.entries
    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s).testTag("media-filter")) {
        options.forEachIndexed { index, kind ->
            SegmentedButton(
                selected = kind == selected,
                onClick = { onSelect(kind) },
                shape = SegmentedButtonDefaults.itemShape(index, options.size),
                modifier = Modifier.testTag("media-filter-${kind?.wire ?: "all"}"),
            ) { Text(filterLabel(kind), maxLines = 1) }
        }
    }
}

@Composable
private fun Grid(
    state: MediaGalleryState,
    gridState: LazyGridState,
    images: MediaImageLoader,
    onOpen: (MediaItem) -> Unit,
    onRetry: () -> Unit,
    onLoadMore: () -> Unit,
    onNear: (Int) -> Unit,
) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(TILE_MIN_SIZE),
        state = gridState,
        horizontalArrangement = Arrangement.spacedBy(TILE_GAP),
        verticalArrangement = Arrangement.spacedBy(TILE_GAP),
        modifier = Modifier.fillMaxSize().testTag("media-grid"),
    ) {
        state.error?.let { error ->
            item(span = { GridItemSpan(maxLineSpan) }) {
                InlineError(errorMessage(error), onRetry, tag = "media-refresh-error")
            }
        }
        itemsIndexed(state.items, key = { _, item -> item.id }) { index, item ->
            LaunchedEffect(item.id) { onNear(index) }
            Tile(item, images, onOpen)
        }
        item(span = { GridItemSpan(maxLineSpan) }) {
            when {
                state.loadingMore -> Box(modifier = Modifier.fillMaxWidth().padding(Spacing.m), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(modifier = Modifier.testTag("media-loading-more"))
                }
                else -> state.loadMoreError?.let { InlineError(errorMessage(it), onLoadMore, tag = "media-load-more-error") }
            }
        }
    }
}

@Composable
private fun Tile(item: MediaItem, images: MediaImageLoader, onOpen: (MediaItem) -> Unit) {
    val kindName = kindName(item.kind)
    val description = stringResource(R.string.media_tile_description, kindName, item.displayTitle ?: kindName)
    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.media_open)) { onOpen(item) }
            .semantics { contentDescription = description }
            .testTag("media-cell-${item.id}"),
        contentAlignment = Alignment.Center,
    ) {
        if (item.kind == MediaKind.IMAGE) {
            // Keyed on the URL too, so a tile that failed on a lapsed URL tries again once a refresh re-signs it.
            val thumbnail by produceState<Bitmap?>(null, item.id, item.url) { value = images.thumbnail(item) }
            val bitmap = thumbnail
            if (bitmap != null) {
                Image(bitmap.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            }
        } else {
            Text(kindName, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun InlineError(message: String, onRetry: () -> Unit, tag: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        TextButton(onClick = onRetry) { Text(stringResource(R.string.action_try_again)) }
    }
}

@Composable
private fun filterLabel(kind: MediaKind?): String = when (kind) {
    null -> stringResource(R.string.media_filter_all)
    MediaKind.IMAGE -> stringResource(R.string.media_filter_images)
    MediaKind.VIDEO -> stringResource(R.string.media_filter_video)
    MediaKind.AUDIO -> stringResource(R.string.media_filter_audio)
}

@Composable
internal fun kindName(kind: MediaKind): String = when (kind) {
    MediaKind.IMAGE -> stringResource(R.string.media_kind_image)
    MediaKind.VIDEO -> stringResource(R.string.media_kind_video)
    MediaKind.AUDIO -> stringResource(R.string.media_kind_audio)
}

@Composable
private fun emptyMessage(kind: MediaKind?): String = when (kind) {
    null -> stringResource(R.string.media_empty_all)
    MediaKind.IMAGE -> stringResource(R.string.media_empty_images)
    MediaKind.VIDEO -> stringResource(R.string.media_empty_video)
    MediaKind.AUDIO -> stringResource(R.string.media_empty_audio)
}

@Composable
internal fun errorMessage(error: MediaError): String = when (error) {
    MediaError.Offline -> stringResource(R.string.media_error_offline)
    MediaError.NotFound -> stringResource(R.string.media_error_not_found)
    MediaError.RateLimited -> stringResource(R.string.media_error_rate_limited)
    MediaError.Unreadable -> stringResource(R.string.media_error_unreadable)
    MediaError.Unplayable -> stringResource(R.string.media_error_unplayable)
    is MediaError.Server -> stringResource(R.string.media_error_server, error.status)
}

// iOS lays tiles out adaptively from a 110pt minimum with hairline gaps; these are the nearest spacing steps.
private val TILE_MIN_SIZE = Spacing.xxl * 2 + Spacing.m
private val TILE_GAP = Spacing.xs / 2
