@file:OptIn(ExperimentalCoroutinesApi::class)

package com.bike4mind.kit.artifacts

import com.bike4mind.kit.networking.ApiException
import java.io.IOException
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class ArtifactControllersTest {
    private fun summary(id: String, type: ArtifactType = ArtifactType.HTML) =
        ArtifactSummary(id, type, "Artifact $id", null, 1, Instant.EPOCH)

    private class FakeBackend(
        val pages: Map<String?, ArtifactPage>,
        var failure: Exception? = null,
        val details: Map<String, ArtifactDetail> = emptyMap(),
    ) : ArtifactsBackend {
        val requestedCursors = mutableListOf<String?>()
        var gets = 0

        override suspend fun list(cursor: String?, limit: Int): ArtifactPage {
            requestedCursors += cursor
            failure?.let { throw it }
            return pages.getValue(cursor)
        }

        override suspend fun get(id: String): ArtifactDetail {
            gets++
            failure?.let { throw it }
            return details.getValue(id)
        }
    }

    @Test
    fun loadsPageOneOnceAndPagesByCursor() = runTest {
        val backend = FakeBackend(mapOf(null to ArtifactPage(listOf(summary("a"), summary("b")), "c1"), "c1" to ArtifactPage(listOf(summary("c")), null)))
        val list = ArtifactListController(backend, this)

        list.load()
        list.load()
        runCurrent()
        assertEquals(listOf<String?>(null), backend.requestedCursors)
        assertEquals(listOf("a", "b"), list.state.value.items.map { it.id })
        assertTrue(list.state.value.canLoadMore)

        list.loadMore()
        list.loadMore()
        runCurrent()
        assertEquals(listOf("a", "b", "c"), list.state.value.items.map { it.id })
        assertFalse(list.state.value.canLoadMore)
        assertEquals(listOf(null, "c1"), backend.requestedCursors)
    }

    @Test
    fun aRepeatedRowFromTheNextPageIsNotShownTwice() = runTest {
        val backend = FakeBackend(mapOf(null to ArtifactPage(listOf(summary("a")), "c1"), "c1" to ArtifactPage(listOf(summary("a"), summary("b")), null)))
        val list = ArtifactListController(backend, this)
        list.load()
        runCurrent()
        list.loadMore()
        runCurrent()

        assertEquals(listOf("a", "b"), list.state.value.items.map { it.id })
    }

    @Test
    fun anEmptyListIsLoadedNotPending() = runTest {
        val list = ArtifactListController(FakeBackend(mapOf(null to ArtifactPage(emptyList(), null))), this)
        list.load()
        runCurrent()

        assertTrue(list.state.value.loaded)
        assertTrue(list.state.value.items.isEmpty())
    }

    @Test
    fun aFailedFirstLoadCanBeRetried() = runTest {
        val backend = FakeBackend(mapOf(null to ArtifactPage(listOf(summary("a")), null)), failure = IOException("offline"))
        val list = ArtifactListController(backend, this)
        list.load()
        runCurrent()
        assertEquals(ArtifactError.Offline, list.state.value.error)

        backend.failure = null
        list.refresh()
        runCurrent()
        assertEquals(null, list.state.value.error)
        assertEquals(listOf("a"), list.state.value.items.map { it.id })
    }

    @Test
    fun aFailedPageTwoKeepsPageOneAndStopsAutoPaging() = runTest {
        val backend = FakeBackend(mapOf(null to ArtifactPage(listOf(summary("a")), "c1"), "c1" to ArtifactPage(listOf(summary("b")), null)))
        val list = ArtifactListController(backend, this)
        list.load()
        runCurrent()
        backend.failure = ApiException(429)
        list.loadMore()
        runCurrent()

        assertEquals(listOf("a"), list.state.value.items.map { it.id })
        assertEquals(ArtifactError.RateLimited, list.state.value.error)
        assertFalse(list.state.value.canLoadMore)

        backend.failure = null
        list.retryLoadMore()
        runCurrent()
        assertEquals(listOf("a", "b"), list.state.value.items.map { it.id })
        assertEquals(null, list.state.value.error)
    }

    @Test
    fun theDetailLoadsItsContentOnce() = runTest {
        val detail = ArtifactDetail(summary("a"), "<h1>Hi</h1>")
        val backend = FakeBackend(emptyMap(), details = mapOf("a" to detail))
        val controller = ArtifactDetailController("a", backend, this)

        assertEquals(ArtifactDetailState.Loading, controller.state.value)
        controller.load()
        runCurrent()
        controller.load()
        runCurrent()

        assertEquals(ArtifactDetailState.Loaded(detail), controller.state.value)
        assertEquals(1, backend.gets)
    }

    @Test
    fun aMissingArtifactIsNotRetryableButAnOutageIs() = runTest {
        val backend = FakeBackend(emptyMap(), failure = ApiException(404))
        val controller = ArtifactDetailController("a", backend, this)
        controller.load()
        runCurrent()
        val missing = assertIs<ArtifactDetailState.Failed>(controller.state.value).error
        assertEquals(ArtifactError.NotFound, missing)
        assertFalse(missing.isRetryable)

        backend.failure = ApiException(503)
        controller.retry()
        runCurrent()
        val outage = assertIs<ArtifactDetailState.Failed>(controller.state.value).error
        assertEquals(ArtifactError.Server(503), outage)
        assertTrue(outage.isRetryable)
    }
}
