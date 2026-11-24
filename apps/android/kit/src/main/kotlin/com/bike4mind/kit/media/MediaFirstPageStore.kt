package com.bike4mind.kit.media

import com.bike4mind.kit.environment.ServerEnvironment
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * Persists page 1 of the media list per kind filter so the gallery renders at once on the next open, before the
 * network answers. Online-first: the cache only ever seeds the screen, the server wins. Twin of apps/ios
 * B4MKit/Media/MediaFirstPageStore.swift.
 */
interface MediaListCache {
    suspend fun load(kind: MediaKind?): MediaPage?

    suspend fun save(page: MediaPage, kind: MediaKind?)

    /** Called on sign-out: cached rows belong to the account that fetched them. */
    suspend fun clear()
}

/** JSON files in [directory], one per server and kind filter, so switching servers never shows another's tiles. */
class FileMediaListCache(
    private val directory: File,
    environment: ServerEnvironment,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
) : MediaListCache {
    private val host = environment.host

    override suspend fun load(kind: MediaKind?): MediaPage? = withContext(io) {
        val file = file(kind)
        if (!file.exists()) return@withContext null
        try {
            json.decodeFromString(CachedPage.serializer(), file.readText()).toPage()
        } catch (failure: IOException) {
            log("Reading the media cache failed", failure)
            null
        } catch (unreadable: SerializationException) {
            // A schema change leaves an unreadable file; drop it rather than fail every open.
            log("Discarding an unreadable media cache", unreadable)
            file.delete()
            null
        } catch (unreadable: IllegalArgumentException) {
            log("Discarding an unreadable media cache", unreadable)
            file.delete()
            null
        }
    }

    override suspend fun save(page: MediaPage, kind: MediaKind?) = withContext(io) {
        try {
            directory.mkdirs()
            val target = file(kind)
            // Write then rename, so a crash mid-write never leaves a half file to read next launch.
            val temp = File(directory, target.name + ".tmp")
            temp.writeText(json.encodeToString(CachedPage.serializer(), CachedPage.from(page)))
            if (!temp.renameTo(target)) {
                target.delete()
                temp.renameTo(target)
            }
            Unit
        } catch (failure: IOException) {
            log("Writing the media cache failed", failure)
        }
    }

    override suspend fun clear() = withContext(io) {
        (listOf<MediaKind?>(null) + MediaKind.entries).forEach { file(it).delete() }
    }

    private fun file(kind: MediaKind?) = File(directory, "media-$host-${kind?.wire ?: "all"}.json")

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}

/** For tests and previews. */
class InMemoryMediaListCache : MediaListCache {
    private val pages = ConcurrentHashMap<String, MediaPage>()

    override suspend fun load(kind: MediaKind?): MediaPage? = pages[key(kind)]

    override suspend fun save(page: MediaPage, kind: MediaKind?) {
        pages[key(kind)] = page
    }

    override suspend fun clear() = pages.clear()
}

/**
 * The one source of page 1 of the media list. Seeds from memory, then disk; every network answer replaces both.
 * Lives in the app graph rather than a screen, which is what makes a re-open instant.
 */
class MediaFirstPageStore(
    private val api: MediaApi,
    private val cache: MediaListCache = InMemoryMediaListCache(),
    val pageSize: Int = 30,
) {
    private val latest = ConcurrentHashMap<String, MediaPage>()

    /** Bumped by [invalidate] so a response in flight at sign-out cannot repopulate the store. */
    private val epoch = AtomicInteger(0)

    /** Makes the epoch check and the write one step, so a sign-out wipe cannot interleave with a save. */
    private val writes = Mutex()

    /** The last page 1 seen for [kind], from memory or else disk. Null on a cold first launch. */
    suspend fun seeded(kind: MediaKind?): MediaPage? {
        latest[key(kind)]?.let { return it }
        val startedAt = epoch.get()
        val page = cache.load(kind) ?: return null
        if (startedAt != epoch.get()) return null
        // A refresh that landed while the disk read was pending is newer than what was read.
        return latest.putIfAbsent(key(kind), page) ?: page
    }

    /** Fetches page 1 from the server and makes it the seed for the next open. */
    suspend fun refresh(kind: MediaKind?): MediaPage {
        val startedAt = epoch.get()
        val page = api.list(kind, page = 1, limit = pageSize)
        writes.withLock {
            if (startedAt != epoch.get()) return page
            latest[key(kind)] = page
            cache.save(page, kind)
        }
        return page
    }

    /** The session ended: forget everything the previous account saw. */
    suspend fun invalidate() {
        epoch.incrementAndGet()
        writes.withLock {
            latest.clear()
            cache.clear()
        }
    }
}

private fun key(kind: MediaKind?) = kind?.wire ?: "all"

@Serializable
private data class CachedPage(val items: List<CachedItem>, val hasMore: Boolean) {
    fun toPage() = MediaPage(items.mapNotNull(CachedItem::toItem), hasMore)

    companion object {
        fun from(page: MediaPage) = CachedPage(page.items.map(CachedItem::from), page.hasMore)
    }
}

@Serializable
private data class CachedItem(
    val id: String,
    val kind: String,
    val fileName: String,
    val mimeType: String,
    val createdAtMillis: Long,
    val fileSize: Long? = null,
    val url: String? = null,
    val urlExpiresAtMillis: Long? = null,
    val prompt: String? = null,
) {
    fun toItem(): MediaItem? = MediaKind.fromWire(kind)?.let {
        MediaItem(
            id = id,
            kind = it,
            fileName = fileName,
            mimeType = mimeType,
            createdAt = Instant.ofEpochMilli(createdAtMillis),
            fileSize = fileSize,
            url = url,
            urlExpiresAt = urlExpiresAtMillis?.let(Instant::ofEpochMilli),
            prompt = prompt,
        )
    }

    companion object {
        fun from(item: MediaItem) = CachedItem(
            id = item.id,
            kind = item.kind.wire,
            fileName = item.fileName,
            mimeType = item.mimeType,
            createdAtMillis = item.createdAt.toEpochMilli(),
            fileSize = item.fileSize,
            url = item.url,
            urlExpiresAtMillis = item.urlExpiresAt?.toEpochMilli(),
            prompt = item.prompt,
        )
    }
}
