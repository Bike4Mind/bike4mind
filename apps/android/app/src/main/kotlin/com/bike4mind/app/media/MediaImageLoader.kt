package com.bike4mind.app.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import android.util.LruCache
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.media.MediaItem
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.readRawBytes
import io.ktor.http.isSuccess
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Loads gallery images from their presigned storage URLs. Tiles are downsampled and kept in memory and on disk by
 * file id, not URL: the URL is re-signed on every list, but the bytes behind an id never change, so a reopened
 * gallery draws its tiles without the network. Counterpart of apps/ios B4MKit/Media/ThumbnailCache.swift, which
 * keeps tiles in memory only and full-size originals on disk; here tiles go to disk, so a cold offline start draws
 * the grid, and full-size images are not cached.
 */
class MediaImageLoader(private val http: HttpClient, directory: File, environment: ServerEnvironment) {
    private val directory = File(directory, environment.host)

    private val memory = object : LruCache<String, Bitmap>(memoryBudgetKb()) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount / 1024
    }

    /** Bumped by [clear]: a load that began before a sign-out must not cache what it fetched for that account. */
    private val generation = AtomicInteger()

    /** Makes a disk write and the sign-out wipe exclusive, so a write cannot land in a directory just deleted. */
    private val diskLock = Mutex()

    /** A grid tile for [item], or null when it has no URL yet or its bytes could not be read. */
    suspend fun thumbnail(item: MediaItem): Bitmap? {
        val started = generation.get()
        memory.get(item.id)?.let { return it }
        // The id names a file on disk, so only a plain id is ever cached.
        if (!Route.isValidId(item.id)) return null
        val file = File(directory, "${item.id}.tile")
        val cached = withContext(Dispatchers.IO) { if (file.exists()) BitmapFactory.decodeFile(file.path) else null }
        if (cached != null) return cached.also { remember(item.id, it, started) }
        val url = item.url ?: return null
        return try {
            val bitmap = decode(download(url), THUMBNAIL_PX) ?: return null
            remember(item.id, bitmap, started)
            diskLock.withLock { if (generation.get() == started) withContext(Dispatchers.IO) { save(bitmap, file) } }
            bitmap
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: IOException) {
            Log.w(TAG, "Loading a gallery tile failed", failure)
            null
        }
    }

    /** The image at [url] at screen size. Throws when the URL no longer serves an image (it may have lapsed). */
    suspend fun full(url: String): Bitmap = decode(download(url), FULL_PX) ?: throw IOException("Not a readable image")

    suspend fun clear() {
        generation.incrementAndGet()
        memory.evictAll()
        diskLock.withLock { withContext(Dispatchers.IO) { directory.parentFile?.deleteRecursively() } }
    }

    private fun remember(id: String, bitmap: Bitmap, started: Int) {
        if (generation.get() != started) return
        memory.put(id, bitmap)
        // A clear() between the check and the put would otherwise leave this tile behind.
        if (generation.get() != started) memory.remove(id)
    }

    private suspend fun download(url: String): ByteArray {
        val response = http.get(url)
        if (!response.status.isSuccess()) throw IOException("Storage answered HTTP ${response.status.value}")
        return response.readRawBytes()
    }

    private suspend fun decode(bytes: ByteArray, maxPx: Int): Bitmap? = withContext(Dispatchers.Default) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
        val options = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxPx) }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }

    private fun save(bitmap: Bitmap, file: File) {
        try {
            directory.mkdirs()
            val temp = File(directory, file.name + ".tmp")
            // JPEG has no alpha channel and would flatten a transparent image onto black; an opaque one stays JPEG,
            // which is several times smaller.
            val format = if (isTransparent(bitmap)) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
            temp.outputStream().use { bitmap.compress(format, JPEG_QUALITY, it) }
            if (!temp.renameTo(file)) temp.delete()
        } catch (failure: IOException) {
            Log.w(TAG, "Saving a gallery tile failed", failure)
        }
    }

    internal companion object {
        const val TAG = "B4MMedia"

        /** Tiles are about a third of a phone's width; this keeps them sharp on dense screens. */
        const val THUMBNAIL_PX = 384

        /** Large enough to zoom on a phone, small enough not to exhaust the heap on a camera-sized original. */
        const val FULL_PX = 2048
        const val JPEG_QUALITY = 85

        /** A decode may use up to this many times maxPx squared pixels, so a very wide image still fits the heap. */
        private const val PIXEL_HEADROOM = 8L

        /**
         * Whether any pixel is not fully opaque. [Bitmap.hasAlpha] only says the format has an alpha channel, which
         * every decoded RGBA PNG has, transparent or not. Reads one row at a time to keep the scan's memory small.
         */
        fun isTransparent(bitmap: Bitmap): Boolean {
            if (!bitmap.hasAlpha()) return false
            val row = IntArray(bitmap.width)
            for (y in 0 until bitmap.height) {
                bitmap.getPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
                if (row.any { it ushr 24 != 0xFF }) return true
            }
            return false
        }

        fun memoryBudgetKb(): Int = (Runtime.getRuntime().maxMemory() / 1024 / 8).toInt()

        /**
         * The power-of-two decode step for a [width] x [height] image: as coarse as keeps both sides at least
         * [maxPx], then coarser while the pixel count is still over budget.
         */
        fun sampleSize(width: Int, height: Int, maxPx: Int): Int {
            var sample = 1
            while (width / (sample * 2) >= maxPx && height / (sample * 2) >= maxPx) sample *= 2
            while ((width / sample).toLong() * (height / sample) > maxPx.toLong() * maxPx * PIXEL_HEADROOM) sample *= 2
            return sample
        }
    }
}
