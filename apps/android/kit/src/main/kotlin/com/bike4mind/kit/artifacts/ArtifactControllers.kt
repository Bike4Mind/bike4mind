package com.bike4mind.kit.artifacts

import com.bike4mind.kit.networking.UpgradeRequiredException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ArtifactListState(
    val items: List<ArtifactSummary> = emptyList(),
    val nextCursor: String? = null,
    /** True while page 1 is loading. */
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    /** The last load failed; kept beside [items] so a failed page 2 does not blank the list. */
    val error: ArtifactError? = null,
    /** True once a load has finished, so an empty list reads as "nothing here" and not as "not loaded". */
    val loaded: Boolean = false,
) {
    val canLoadMore: Boolean
        get() = nextCursor != null && !loading && !loadingMore && error == null
}

/** The owned-artifacts list, newest first, paged by cursor. [scope] is the screen's. */
class ArtifactListController(private val backend: ArtifactsBackend, private val scope: CoroutineScope) {
    private val mutableState = MutableStateFlow(ArtifactListState())
    val state: StateFlow<ArtifactListState> = mutableState.asStateFlow()
    private var job: Job? = null

    /** First open: loads page 1 once. Later calls do nothing; use [refresh]. */
    fun load() {
        if (!state.value.loaded && !state.value.loading) refresh()
    }

    /** Page 1 again; also "Try again" after a failed first load. */
    fun refresh() {
        job?.cancel()
        mutableState.update { it.copy(loading = true, loadingMore = false, error = null) }
        job = scope.launch {
            try {
                val page = backend.list(cursor = null)
                mutableState.update { it.copy(items = page.items, nextCursor = page.nextCursor, loading = false, loaded = true) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (upgrade: UpgradeRequiredException) {
                // The upgrade screen covers the app; there is nothing to say here.
                mutableState.update { it.copy(loading = false) }
            } catch (failure: Exception) {
                mutableState.update { it.copy(loading = false, error = ArtifactError.from(failure)) }
            }
        }
    }

    /** The next page; ignored while one is loading, when there is none, or after a failure (use [retryLoadMore]). */
    fun loadMore() {
        val cursor = state.value.nextCursor
        if (cursor == null || !state.value.canLoadMore) return
        fetchMore(cursor)
    }

    fun retryLoadMore() {
        val cursor = state.value.nextCursor ?: return
        if (state.value.loadingMore || state.value.loading) return
        fetchMore(cursor)
    }

    private fun fetchMore(cursor: String) {
        mutableState.update { it.copy(loadingMore = true, error = null) }
        job = scope.launch {
            try {
                val page = backend.list(cursor)
                // A row the cursor repeats (an artifact updated mid-paging) must not appear twice.
                mutableState.update {
                    val seen = it.items.mapTo(HashSet()) { item -> item.id }
                    it.copy(items = it.items + page.items.filter { item -> item.id !in seen }, nextCursor = page.nextCursor, loadingMore = false)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (upgrade: UpgradeRequiredException) {
                mutableState.update { it.copy(loadingMore = false) }
            } catch (failure: Exception) {
                mutableState.update { it.copy(loadingMore = false, error = ArtifactError.from(failure)) }
            }
        }
    }
}

sealed interface ArtifactDetailState {
    data object Loading : ArtifactDetailState
    data class Loaded(val detail: ArtifactDetail) : ArtifactDetailState
    data class Failed(val error: ArtifactError) : ArtifactDetailState
}

/** One artifact open. [id] is fetched on [load], so a list row's summary never stands in for its content. */
class ArtifactDetailController(private val id: String, private val backend: ArtifactsBackend, private val scope: CoroutineScope) {
    private val mutableState = MutableStateFlow<ArtifactDetailState>(ArtifactDetailState.Loading)
    val state: StateFlow<ArtifactDetailState> = mutableState.asStateFlow()
    private var job: Job? = null

    fun load() {
        if (job?.isActive == true || state.value is ArtifactDetailState.Loaded) return
        retry()
    }

    fun retry() {
        job?.cancel()
        mutableState.value = ArtifactDetailState.Loading
        job = scope.launch {
            try {
                mutableState.value = ArtifactDetailState.Loaded(backend.get(id))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (upgrade: UpgradeRequiredException) {
                // The upgrade screen covers the app; keep the spinner behind it.
            } catch (failure: Exception) {
                mutableState.value = ArtifactDetailState.Failed(ArtifactError.from(failure))
            }
        }
    }
}
