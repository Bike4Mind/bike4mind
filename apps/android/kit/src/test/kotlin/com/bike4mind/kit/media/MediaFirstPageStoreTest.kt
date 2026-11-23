package com.bike4mind.kit.media

import com.bike4mind.kit.environment.ServerEnvironment
import java.io.File
import java.nio.file.Files
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class MediaFirstPageStoreTest {
    private val directory: File = Files.createTempDirectory("media-cache").toFile()

    @AfterTest
    fun cleanUp() {
        directory.deleteRecursively()
    }

    private fun fileCache(environment: ServerEnvironment = STAGING, dispatcher: kotlinx.coroutines.CoroutineDispatcher) =
        FileMediaListCache(directory, environment, dispatcher)

    @Test
    fun theFileCacheRoundTripsAPagePerKind() = runTest {
        val cache = fileCache(dispatcher = StandardTestDispatcher(testScheduler))
        cache.save(PAGE, MediaKind.IMAGE)

        assertEquals(PAGE, cache.load(MediaKind.IMAGE))
        assertNull(cache.load(null))
        assertNull(cache.load(MediaKind.VIDEO))
    }

    @Test
    fun theFileCacheIsPerServer() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        fileCache(dispatcher = dispatcher).save(PAGE, null)
        assertNull(fileCache(ServerEnvironment.Production, dispatcher).load(null))
    }

    @Test
    fun anUnreadableCacheFileIsDroppedNotFatal() = runTest {
        val cache = fileCache(dispatcher = StandardTestDispatcher(testScheduler))
        cache.save(PAGE, null)
        val file = directory.listFiles()!!.single()
        file.writeText("""{"items":"not a list"}""")

        assertNull(cache.load(null))
        assertTrue(!file.exists())
    }

    @Test
    fun clearForgetsEveryKind() = runTest {
        val cache = fileCache(dispatcher = StandardTestDispatcher(testScheduler))
        cache.save(PAGE, null)
        cache.save(PAGE, MediaKind.AUDIO)
        cache.clear()
        assertNull(cache.load(null))
        assertNull(cache.load(MediaKind.AUDIO))
    }

    @Test
    fun aColdStoreSeedsFromDiskThenRefreshReplacesIt() = runTest {
        val cache = InMemoryMediaListCache().apply { save(PAGE, null) }
        val api = FakeMediaApi().apply { pages[null] = listOf(FRESH) }
        val store = MediaFirstPageStore(api, cache)

        assertEquals(PAGE, store.seeded(null))
        assertEquals(FRESH, store.refresh(null))
        assertEquals(FRESH, store.seeded(null))
        assertEquals(FRESH, cache.load(null))
    }

    @Test
    fun nothingSeedsOnAColdFirstLaunch() = runTest {
        assertNull(MediaFirstPageStore(FakeMediaApi()).seeded(MediaKind.IMAGE))
    }

    @Test
    fun aRefreshInFlightAtSignOutDoesNotRepopulate() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = FakeMediaApi().apply {
            pages[null] = listOf(FRESH)
            this.gate = gate
        }
        val cache = InMemoryMediaListCache()
        val store = MediaFirstPageStore(api, cache)

        val refresh = launch { store.refresh(null) }
        runCurrent()
        store.invalidate()
        gate.complete(Unit)
        refresh.join()

        assertNull(store.seeded(null))
        assertNull(cache.load(null))
    }

    private companion object {
        val STAGING = ServerEnvironment.Custom("https://staging.example.test")
        val PAGE = MediaPage(
            listOf(
                mediaItem("a", MediaKind.IMAGE).copy(
                    fileSize = 10,
                    url = "https://files.example.test/a",
                    urlExpiresAt = Instant.parse("2026-11-20T11:00:00Z"),
                    prompt = "p",
                ),
                mediaItem("b", MediaKind.AUDIO),
            ),
            hasMore = true,
        )
        val FRESH = MediaPage(listOf(mediaItem("c", MediaKind.VIDEO)), hasMore = false)
    }
}

internal fun mediaItem(id: String, kind: MediaKind = MediaKind.IMAGE) = MediaItem(
    id = id,
    kind = kind,
    fileName = "$id.bin",
    mimeType = "${kind.wire}/x",
    createdAt = Instant.parse("2026-11-20T10:00:00Z"),
)

/** Answers each kind's pages in order; [gate] holds every answer until completed. */
internal class FakeMediaApi : MediaApi {
    val pages = mutableMapOf<MediaKind?, List<MediaPage>>()
    val items = mutableMapOf<String, ArrayDeque<MediaItem>>()
    var failure: Exception? = null
    var gate: CompletableDeferred<Unit>? = null
    val listCalls = mutableListOf<Pair<MediaKind?, Int>>()
    val itemCalls = mutableListOf<String>()

    override suspend fun list(kind: MediaKind?, page: Int, limit: Int): MediaPage {
        listCalls += kind to page
        gate?.await()
        failure?.let { throw it }
        return pages[kind]?.getOrNull(page - 1) ?: MediaPage(emptyList(), hasMore = false)
    }

    override suspend fun item(id: String): MediaItem {
        itemCalls += id
        gate?.await()
        failure?.let { throw it }
        val queue = items.getValue(id)
        return if (queue.size > 1) queue.removeFirst() else queue.first()
    }
}
