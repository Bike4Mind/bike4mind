package com.bike4mind.app.capture

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A local copy of something the user picked, ready to upload. */
data class PickedFile(val file: File, val name: String, val mimeType: String)

/** Local files behind capture: photos the camera writes, scans and picked files copied out of their providers. */
object CaptureFiles {
    fun directory(context: Context): File = File(context.cacheDir, "capture").apply { mkdirs() }

    /** A file the camera app writes into, and the content URI it is handed (res/xml/capture_paths.xml). */
    fun newPhoto(context: Context): Pair<File, Uri> {
        val file = File(directory(context), "photo-${UUID.randomUUID()}.jpg")
        return file to FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    }

    /** Local time, file-name safe: 2026-11-23 1405. */
    fun stamp(): String = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HHmm"))

    fun displayName(resolver: ContentResolver, uri: Uri): String? =
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull()?.takeIf { it.isNotBlank() }

    /**
     * The provider's display name, else the URI's last segment with an extension for [mimeType], so the server
     * and the model can still tell what the file is.
     */
    fun fileName(resolver: ContentResolver, uri: Uri, mimeType: String): String {
        displayName(resolver, uri)?.let { return it }
        val base = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "file"
        val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType)
        return if (extension == null || base.contains('.')) base else "$base.$extension"
    }

    fun mimeType(resolver: ContentResolver, uri: Uri, fallback: String? = null): String =
        resolver.getType(uri) ?: fallback?.takeIf { '*' !in it } ?: "application/octet-stream"

    /** Copies [uri] into the cache, since a provider's grant ends with the activity that received it. */
    suspend fun copy(context: Context, uri: Uri, name: String? = null, mimeType: String? = null): PickedFile? =
        withContext(Dispatchers.IO) {
            val resolver = context.contentResolver
            val target = File(directory(context), "picked-${UUID.randomUUID()}")
            val copied = runCatching {
                resolver.openInputStream(uri)?.use { input -> target.outputStream().use { input.copyTo(it) } }
            }.getOrNull()
            if (copied == null) {
                target.delete()
                return@withContext null
            }
            val type = mimeType ?: mimeType(resolver, uri)
            PickedFile(target, name ?: fileName(resolver, uri, type), type)
        }
}
