package com.bike4mind.kit.media

import com.bike4mind.kit.networking.UpgradeRequiredException
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class MediaGalleryState(
    val items: List<MediaItem> = emptyList(),
    /** Null shows every kind. */
    val kind: MediaKind? = null,
    /** True until page 1 (seeded or fetched) is on screen for this filter. */
    val loading: Boolean = true,
    /** The last page-1 load failed. Kept alongside [items] so a failed refresh does not blank a seeded grid. */
    val error: MediaError? = null,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val loadMoreError: MediaError? = null,
    val hasMore: Boolean = false,
) {
    val canLoadMore: Boolean
        get() = hasMore && !loadingMore && !refreshing
}

/**
 * The Studio gallery: a newest-first grid of generated files, filterable by kind, paged by number, and rendered
 * stale-first from [firstPages]. Twin of apps/ios MediaGalleryViewModel; [scope] is the screen's.
 */
class MediaGalleryController(
    private val api: MediaApi,
    private val firstPages: MediaFirstPageStore,
    private val scope: CoroutineScope,
) {
    private val mutableState = MutableStateFlow(MediaGalleryState())
    val state: StateFlow<MediaGalleryState> = mutableState.asStateFlow()

    private var nextPage = 1
    private var started = false

    /** Bumped on every filter change so a late answer for the old filter cannot touch the new one. */
    private var generation = 0
    private var refreshJob: Job? = null
    private var loadMoreJob: Job? = null

    /** The furthest cell reported by [loadMoreIfNeeded], re-checked when a refresh ends so paging cannot stall. */
    private var lastNear = -1

    /** First open: the seed, then the network. Later calls do nothing; use [refresh]. */
    fun load() {
        if (started) return
        started = true
        restart()
    }

    fun select(kind: MediaKind?) {
        if (kind == state.value.kind && started) return
        started = true
        // The old filter's answers must not land on the new filter's grid.
        refreshJob?.cancel()
        loadMoreJob?.cancel()
        nextPage = 1
        lastNear = -1
        generation++
        mutableState.value = MediaGalleryState(kind = kind)
        restart()
    }

    private fun restart() {
        val kind = state.value.kind
        val requested = generation
        mutableState.update { it.copy(refreshing = true) }
        refreshJob = scope.launch {
            firstPages.seeded(kind)?.let { page -> if (requested == generation && state.value.items.isEmpty()) apply(page) }
            fetchFirstPage(kind, requested)
        }
    }

    /** Pull to refresh and "Try again". */
    fun refresh() {
        if (state.value.refreshing) return
        val kind = state.value.kind
        val requested = generation
        mutableState.update { it.copy(refreshing = true) }
        refreshJob = scope.launch { fetchFirstPage(kind, requested) }
    }

    private suspend fun fetchFirstPage(kind: MediaKind?, requested: Int) {
        mutableState.update { it.copy(loading = it.items.isEmpty()) }
        try {
            val page = firstPages.refresh(kind)
            if (requested != generation) return
            // Join so the cancelled load's cleanup cannot clear the flag of a load started after this refresh.
            loadMoreJob?.cancelAndJoin()
            apply(page)
            // A tall screen shows every cell of page 1 at once, so no later cell appears to ask for page 2; a page of
            // only skipped rows has no cells at all. Ask again now that the refresh is over.
            mutableState.update { it.copy(refreshing = false) }
            if (lastNear >= 0 || page.items.isEmpty()) loadMoreIfNeeded(lastNear)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (upgrade: UpgradeRequiredException) {
            // The upgrade screen covers the app; there is nothing to say here.
            if (requested == generation) mutableState.update { it.copy(loading = false) }
        } catch (failure: Exception) {
            if (requested == generation) mutableState.update { it.copy(loading = false, error = MediaError.from(failure)) }
        } finally {
            if (requested == generation) mutableState.update { it.copy(refreshing = false) }
        }
    }

    private fun apply(page: MediaPage) {
        nextPage = 2
        mutableState.update {
            it.copy(items = page.items, hasMore = page.hasMore, loading = false, error = null, loadMoreError = null, loadingMore = false)
        }
    }

    /** Call as each cell appears; fetches the next page when the cell is near the end of what is loaded. */
    fun loadMoreIfNeeded(index: Int) {
        lastNear = maxOf(lastNear, index)
        if (index >= state.value.items.size - PREFETCH_DISTANCE) loadMore()
    }

    fun loadMore() {
        if (!state.value.canLoadMore) return
        val kind = state.value.kind
        val requested = generation
        mutableState.update { it.copy(loadingMore = true, loadMoreError = null) }
        loadMoreJob = scope.launch {
            try {
                var attempts = 0
                do {
                    val next = api.list(kind, nextPage, firstPages.pageSize)
                    if (requested != generation) return@launch
                    nextPage++
                    var added = 0
                    mutableState.update { current ->
                        val known = current.items.mapTo(HashSet()) { it.id }
                        val fresh = next.items.filterNot { it.id in known }
                        added = fresh.size
                        current.copy(items = current.items + fresh, hasMore = next.hasMore)
                    }
                    // Rows the gallery cannot draw are dropped, so a whole page can add nothing; keep going rather than stall.
                } while (added == 0 && next.hasMore && ++attempts < MAX_EMPTY_PAGES)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (upgrade: UpgradeRequiredException) {
                // The upgrade screen covers the app; there is nothing to say here.
                return@launch
            } catch (failure: Exception) {
                if (requested == generation) mutableState.update { it.copy(loadMoreError = MediaError.from(failure)) }
            } finally {
                if (requested == generation) mutableState.update { it.copy(loadingMore = false) }
            }
        }
    }

    private companion object {
        const val PREFETCH_DISTANCE = 6
        const val MAX_EMPTY_PAGES = 5
    }
}

data class MediaDetailState(
    val item: MediaItem,
    val refreshing: Boolean = false,
    val error: MediaError? = null,
) {
    /** The URL to hand the loader or player, once one is in hand and no refetch is pending. */
    val playableUrl: String?
        get() = item.url.takeIf { !refreshing && error == null }
}

/**
 * One item on screen. Owns the "presigned URLs are short-lived" policy: refetch the detail before playback when
 * the URL is near expiry, and again when playback fails, never in a loop. Twin of apps/ios MediaDetailViewModel.
 */
class MediaDetailController(
    item: MediaItem,
    private val api: MediaApi,
    private val scope: CoroutineScope,
    private val now: () -> Instant = Instant::now,
) {
    private val mutableState = MutableStateFlow(MediaDetailState(item))
    val state: StateFlow<MediaDetailState> = mutableState.asStateFlow()

    private var consecutiveRefreshes = 0
    private var job: Job? = null

    /** Fetches a fresh URL when the one in hand is missing or about to lapse. */
    fun prepare() {
        if (state.value.item.isUrlUsable(now())) return
        refetch()
    }

    /** The loader or player could not use the URL: fetch a fresh one, up to [MAX_CONSECUTIVE_REFRESHES] times. */
    fun playbackFailed() {
        if (state.value.refreshing) return
        if (consecutiveRefreshes >= MAX_CONSECUTIVE_REFRESHES) {
            mutableState.update { it.copy(error = MediaError.Unplayable) }
            return
        }
        consecutiveRefreshes++
        refetch()
    }

    fun playbackSucceeded() {
        consecutiveRefreshes = 0
    }

    /** The user asked to try again after a failure: a fresh budget and a fresh URL. */
    fun retry() {
        consecutiveRefreshes = 0
        refetch()
    }

    private fun refetch() {
        job?.cancel()
        mutableState.update { it.copy(refreshing = true, error = null) }
        job = scope.launch {
            try {
                val fresh = api.item(state.value.item.id)
                mutableState.update {
                    it.copy(item = fresh, refreshing = false, error = if (fresh.url == null) MediaError.NotFound else null)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (upgrade: UpgradeRequiredException) {
                mutableState.update { it.copy(refreshing = false) }
            } catch (failure: Exception) {
                mutableState.update { it.copy(refreshing = false, error = MediaError.from(failure)) }
            }
        }
    }

    companion object {
        /** A failed playback triggers at most this many refetches in a row; [playbackSucceeded] resets the count. */
        const val MAX_CONSECUTIVE_REFRESHES = 2
    }
}
