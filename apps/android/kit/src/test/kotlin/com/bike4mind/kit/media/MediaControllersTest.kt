@file:OptIn(ExperimentalCoroutinesApi::class)

package com.bike4mind.kit.media

import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.ClientUpgradeNotice
import com.bike4mind.kit.networking.UpgradeRequiredException
import java.io.IOException
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class MediaGalleryControllerTest {
    private fun TestScope.gallery(api: FakeMediaApi, cache: MediaListCache = InMemoryMediaListCache(), pageSize: Int = 2) =
        MediaGalleryController(api, MediaFirstPageStore(api, cache, pageSize), backgroundScope)

    @Test
    fun loadsPageOneNewestFirst() = runTest {
        val api = FakeMediaApi().apply { pages[null] = listOf(page("a", "b", hasMore = true)) }
        val gallery = gallery(api)

        gallery.load()
        runCurrent()

        val state = gallery.state.value
        assertEquals(listOf("a", "b"), state.items.map { it.id })
        assertFalse(state.loading)
        assertFalse(state.refreshing)
        assertTrue(state.canLoadMore)
        assertNull(state.error)
    }

    @Test
    fun rendersTheCachedPageBeforeTheNetworkAnswers() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = FakeMediaApi().apply {
            pages[null] = listOf(page("fresh"))
            this.gate = gate
        }
        val cache = InMemoryMediaListCache().apply { save(page("stale"), null) }
        val gallery = gallery(api, cache)

        gallery.load()
        runCurrent()
        assertEquals(listOf("stale"), gallery.state.value.items.map { it.id })
        assertFalse(gallery.state.value.loading)
        assertTrue(gallery.state.value.refreshing)

        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("fresh"), gallery.state.value.items.map { it.id })
        assertFalse(gallery.state.value.refreshing)
    }

    @Test
    fun aFailedRefreshKeepsTheSeededGrid() = runTest {
        val api = FakeMediaApi().apply { failure = IOException("offline") }
        val cache = InMemoryMediaListCache().apply { save(page("stale"), null) }
        val gallery = gallery(api, cache)

        gallery.load()
        runCurrent()

        assertEquals(listOf("stale"), gallery.state.value.items.map { it.id })
        assertEquals(MediaError.Offline, gallery.state.value.error)
    }

    @Test
    fun aFailedColdLoadIsAnErrorAndTryAgainRecovers() = runTest {
        val api = FakeMediaApi().apply {
            pages[null] = listOf(page("a"))
            failure = ApiException(500)
        }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()
        assertEquals(MediaError.Server(500), gallery.state.value.error)
        assertTrue(gallery.state.value.items.isEmpty())

        api.failure = null
        gallery.refresh()
        runCurrent()
        assertEquals(listOf("a"), gallery.state.value.items.map { it.id })
        assertNull(gallery.state.value.error)
    }

    @Test
    fun pagesNearTheEndAndDropsDuplicates() = runTest {
        val api = FakeMediaApi().apply { pages[null] = listOf(page("a", "b", hasMore = true), page("b", "c")) }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()

        gallery.loadMoreIfNeeded(index = 1)
        runCurrent()

        assertEquals(listOf("a", "b", "c"), gallery.state.value.items.map { it.id })
        assertFalse(gallery.state.value.hasMore)
        assertEquals(listOf<Pair<MediaKind?, Int>>(null to 1, null to 2), api.listCalls)

        gallery.loadMore()
        runCurrent()
        assertEquals(2, api.listCalls.size)
    }

    @Test
    fun aFailedNextPageKeepsTheGridAndCanRetry() = runTest {
        val api = FakeMediaApi().apply { pages[null] = listOf(page("a", "b", hasMore = true), page("c")) }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()

        api.failure = IOException("offline")
        gallery.loadMore()
        runCurrent()
        assertEquals(MediaError.Offline, gallery.state.value.loadMoreError)
        assertEquals(2, gallery.state.value.items.size)

        api.failure = null
        gallery.loadMore()
        runCurrent()
        assertEquals(listOf("a", "b", "c"), gallery.state.value.items.map { it.id })
        assertNull(gallery.state.value.loadMoreError)
    }

    @Test
    fun aSlowAnswerForTheOldFilterNeverLandsOnTheNewOne() = runTest {
        val api = FakeMediaApi().apply {
            pages[null] = listOf(page("all"))
            pages[MediaKind.AUDIO] = listOf(page("song", kind = MediaKind.AUDIO))
            kindGates[null] = CompletableDeferred()
            kindGates[MediaKind.AUDIO] = CompletableDeferred()
        }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()

        gallery.select(MediaKind.AUDIO)
        api.kindGates.getValue(MediaKind.AUDIO).complete(Unit)
        runCurrent()
        api.kindGates.getValue(null).complete(Unit)
        runCurrent()

        val state = gallery.state.value
        assertEquals(MediaKind.AUDIO, state.kind)
        assertEquals(listOf("song"), state.items.map { it.id })
        assertFalse(state.refreshing)
    }

    @Test
    fun pagingResumesWhenARefreshEndsAfterEveryCellWasAlreadyReported() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = FakeMediaApi().apply {
            pages[null] = listOf(page("a", "b", hasMore = true), page("c"))
            this.gate = gate
        }
        val gallery = gallery(api, InMemoryMediaListCache().apply { save(page("a", "b", hasMore = true), null) })
        gallery.load()
        runCurrent()

        gallery.loadMoreIfNeeded(index = 1)
        assertEquals(1, api.listCalls.size)

        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("a", "b", "c"), gallery.state.value.items.map { it.id })
    }

    @Test
    fun aPageOfOnlySkippedRowsFetchesTheNextOne() = runTest {
        val api = FakeMediaApi().apply { pages[null] = listOf(page(hasMore = true), page("a")) }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()

        assertEquals(listOf("a"), gallery.state.value.items.map { it.id })
        assertEquals(listOf<Pair<MediaKind?, Int>>(null to 1, null to 2), api.listCalls)
    }

    @Test
    fun aRefreshDuringALoadMoreDoesNotSkipAPage() = runTest {
        val api = FakeMediaApi().apply { pages[null] = listOf(page("a", hasMore = true), page("b", hasMore = true), page("c")) }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()

        val pageTwo = CompletableDeferred<Unit>()
        api.pageGates[2] = pageTwo
        gallery.loadMoreIfNeeded(index = 0)
        runCurrent()
        gallery.refresh()
        runCurrent()
        gallery.loadMoreIfNeeded(index = 0)
        runCurrent()
        pageTwo.complete(Unit)
        runCurrent()
        gallery.loadMoreIfNeeded(index = 0)
        runCurrent()

        assertEquals(listOf("a", "b", "c"), gallery.state.value.items.map { it.id })
    }

    @Test
    fun anEmptyLaterPageFetchesTheNextOne() = runTest {
        val api = FakeMediaApi().apply { pages[null] = listOf(page("a", hasMore = true), page(hasMore = true), page("b")) }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()
        gallery.loadMoreIfNeeded(index = 0)
        runCurrent()

        assertEquals(listOf("a", "b"), gallery.state.value.items.map { it.id })
    }

    @Test
    fun aRefusedBuildEndsTheLoadWithoutAnError() = runTest {
        val api = FakeMediaApi().apply { failure = UpgradeRequiredException(ClientUpgradeNotice("9.9.9")) }
        val gallery = gallery(api)

        gallery.load()
        runCurrent()

        assertFalse(gallery.state.value.loading)
        assertFalse(gallery.state.value.refreshing)
        assertNull(gallery.state.value.error)
    }

    @Test
    fun aNextPageInFlightWhenTheFilterChangesNeverLandsOnTheNewFilter() = runTest {
        val api = FakeMediaApi().apply {
            pages[null] = listOf(page("a", "b", hasMore = true), page("c"))
            pages[MediaKind.VIDEO] = listOf(page("v", kind = MediaKind.VIDEO))
            pageGates[2] = CompletableDeferred()
        }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()
        gallery.loadMore()
        runCurrent()
        assertTrue(gallery.state.value.loadingMore)

        gallery.select(MediaKind.VIDEO)
        runCurrent()
        api.pageGates.getValue(2).complete(Unit)
        runCurrent()

        val state = gallery.state.value
        assertEquals(MediaKind.VIDEO, state.kind)
        assertEquals(listOf("v"), state.items.map { it.id })
        assertFalse(state.loadingMore)
    }

    @Test
    fun noNextPageIsFetchedWhileARefreshIsRunning() = runTest {
        val api = FakeMediaApi().apply { pages[null] = listOf(page("a", "b", hasMore = true), page("c")) }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()

        api.pageGates[1] = CompletableDeferred()
        gallery.refresh()
        runCurrent()
        gallery.loadMore()
        runCurrent()

        assertEquals(listOf<Pair<MediaKind?, Int>>(null to 1, null to 1), api.listCalls)
    }

    @Test
    fun theNextPageIsFetchedOnlyOnceACellIsWithinThePrefetchDistance() = runTest {
        val first = Array(10) { "i$it" }
        val api = FakeMediaApi().apply { pages[null] = listOf(page(*first, hasMore = true), page("next")) }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()

        // Ten cells and a prefetch distance of six: cell 3 is still too far from the end, cell 4 is not.
        gallery.loadMoreIfNeeded(index = 3)
        runCurrent()
        assertEquals(listOf<Pair<MediaKind?, Int>>(null to 1), api.listCalls)

        gallery.loadMoreIfNeeded(index = 4)
        runCurrent()
        assertEquals(listOf<Pair<MediaKind?, Int>>(null to 1, null to 2), api.listCalls)
    }

    @Test
    fun selectingTheSameFilterDoesNothing() = runTest {
        val api = FakeMediaApi().apply { pages[null] = listOf(page("a")) }
        val gallery = gallery(api)
        gallery.load()
        runCurrent()
        gallery.select(null)
        runCurrent()
        assertEquals(1, api.listCalls.size)
    }

    private fun page(vararg ids: String, hasMore: Boolean = false, kind: MediaKind = MediaKind.IMAGE) =
        MediaPage(ids.map { mediaItem(it, kind) }, hasMore)
}

class MediaDetailControllerTest {
    private val now = Instant.parse("2026-11-20T10:00:00Z")

    private fun TestScope.detail(item: MediaItem, api: FakeMediaApi) =
        MediaDetailController(item, api, backgroundScope) { now }

    @Test
    fun aUsableUrlIsNotRefetched() = runTest {
        val api = FakeMediaApi()
        val detail = detail(mediaItem("a").copy(url = "https://u/a", urlExpiresAt = now.plusSeconds(600)), api)
        detail.prepare()
        runCurrent()
        assertTrue(api.itemCalls.isEmpty())
        assertEquals("https://u/a", detail.state.value.playableUrl)
    }

    @Test
    fun aUrlAboutToLapseIsRefetchedFirst() = runTest {
        val api = FakeMediaApi().apply { items["a"] = ArrayDeque(listOf(mediaItem("a").copy(url = "https://u/fresh"))) }
        val detail = detail(mediaItem("a").copy(url = "https://u/old", urlExpiresAt = now.plusSeconds(30)), api)

        detail.prepare()
        assertNull(detail.state.value.playableUrl)
        runCurrent()

        assertEquals(listOf("a"), api.itemCalls)
        assertEquals("https://u/fresh", detail.state.value.playableUrl)
    }

    @Test
    fun playbackFailuresRefetchTwiceThenGiveUp() = runTest {
        val api = FakeMediaApi().apply { items["a"] = ArrayDeque(listOf(mediaItem("a").copy(url = "https://u/fresh"))) }
        val detail = detail(mediaItem("a").copy(url = "https://u/a"), api)

        repeat(2) {
            detail.playbackFailed()
            runCurrent()
        }
        assertEquals(2, api.itemCalls.size)
        assertNull(detail.state.value.error)

        detail.playbackFailed()
        runCurrent()
        assertEquals(2, api.itemCalls.size)
        assertEquals(MediaError.Unplayable, detail.state.value.error)

        detail.retry()
        runCurrent()
        assertEquals(3, api.itemCalls.size)
        assertNull(detail.state.value.error)
    }

    @Test
    fun aSuccessResetsTheRefetchBudget() = runTest {
        val api = FakeMediaApi().apply { items["a"] = ArrayDeque(listOf(mediaItem("a").copy(url = "https://u/fresh"))) }
        val detail = detail(mediaItem("a").copy(url = "https://u/a"), api)
        repeat(2) {
            detail.playbackFailed()
            runCurrent()
        }
        detail.playbackSucceeded()
        detail.playbackFailed()
        runCurrent()
        assertEquals(3, api.itemCalls.size)
        assertNull(detail.state.value.error)
    }

    @Test
    fun aFailedRefetchIsAnErrorAndRetryRecovers() = runTest {
        val api = FakeMediaApi().apply {
            items["a"] = ArrayDeque(listOf(mediaItem("a").copy(url = "https://u/fresh")))
            failure = IOException("offline")
        }
        val detail = detail(mediaItem("a").copy(url = "https://u/old", urlExpiresAt = now.plusSeconds(30)), api)

        detail.prepare()
        runCurrent()
        assertEquals(MediaError.Offline, detail.state.value.error)
        assertNull(detail.state.value.playableUrl)
        assertFalse(detail.state.value.refreshing)

        api.failure = null
        detail.retry()
        runCurrent()
        assertNull(detail.state.value.error)
        assertEquals("https://u/fresh", detail.state.value.playableUrl)
    }

    @Test
    fun aRefusedBuildEndsTheRefetchWithoutAnError() = runTest {
        val api = FakeMediaApi().apply { failure = UpgradeRequiredException(ClientUpgradeNotice(null)) }
        val detail = detail(mediaItem("a"), api)

        detail.prepare()
        runCurrent()

        assertFalse(detail.state.value.refreshing)
        assertNull(detail.state.value.error)
    }

    @Test
    fun anItemWithNoUrlYetIsNotFound() = runTest {
        val api = FakeMediaApi().apply { items["a"] = ArrayDeque(listOf(mediaItem("a"))) }
        val detail = detail(mediaItem("a"), api)
        detail.prepare()
        runCurrent()
        assertEquals(MediaError.NotFound, detail.state.value.error)
    }
}
