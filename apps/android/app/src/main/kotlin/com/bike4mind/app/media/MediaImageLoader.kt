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
import java.net.URI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Loads gallery images from their presigned storage URLs. Tiles are downsampled and kept in memory and on disk by
 * file id, not URL: the URL is re-signed on every list, but the bytes behind an id never change, so a reopened
 * gallery draws its tiles without the network. Twin of apps/ios B4MKit/Media/ThumbnailCache.swift.
 */
class MediaImageLoader(private val http: HttpClient, directory: File, environment: ServerEnvironment) {
    private val host = runCatching { URI(environment.baseUrl).host }.getOrNull() ?: "default"
    private val directory = File(directory, host)

    private val memory = object : LruCache<String, Bitmap>(memoryBudgetKb()) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount / 1024
    }

    /** A grid tile for [item], or null when it has no URL yet or its bytes could not be read. */
    suspend fun thumbnail(item: MediaItem): Bitmap? {
        memory.get(item.id)?.let { return it }
        // The id names a file on disk, so only a plain id is ever cached.
        if (!Route.isValidId(item.id)) return null
        val file = File(directory, "${item.id}.jpg")
        val cached = withContext(Dispatchers.IO) { if (file.exists()) BitmapFactory.decodeFile(file.path) else null }
        if (cached != null) return cached.also { memory.put(item.id, it) }
        val url = item.url ?: return null
        return try {
            val bitmap = decode(download(url), THUMBNAIL_PX) ?: return null
            memory.put(item.id, bitmap)
            withContext(Dispatchers.IO) { save(bitmap, file) }
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
        memory.evictAll()
        withContext(Dispatchers.IO) { directory.parentFile?.deleteRecursively() }
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
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxPx && bounds.outHeight / (sample * 2) >= maxPx) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun save(bitmap: Bitmap, file: File) {
        try {
            directory.mkdirs()
            val temp = File(directory, file.name + ".tmp")
            temp.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
            if (!temp.renameTo(file)) temp.delete()
        } catch (failure: IOException) {
            Log.w(TAG, "Saving a gallery tile failed", failure)
        }
    }

    private companion object {
        const val TAG = "B4MMedia"

        /** Tiles are about a third of a phone's width; this keeps them sharp on dense screens. */
        const val THUMBNAIL_PX = 384

        /** Large enough to zoom on a phone, small enough not to exhaust the heap on a camera-sized original. */
        const val FULL_PX = 2048
        const val JPEG_QUALITY = 85

        fun memoryBudgetKb(): Int = (Runtime.getRuntime().maxMemory() / 1024 / 8).toInt()
    }
}
