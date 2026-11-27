package com.bike4mind.app.capture

import android.content.Context
import android.net.Uri
import android.util.Log
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * On-device OCR for a scan. The scanner's PDF has no guaranteed text layer and the server has no OCR, so this
 * text is what lets the assistant read a scanned bill. Unreadable pages are skipped; "" when nothing was read.
 */
object ScanText {
    suspend fun read(context: Context, pages: List<Uri>): String {
        val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        try {
            return pages.mapNotNull { page -> recognize(context, recognizer, page)?.takeIf { it.isNotBlank() } }
                .joinToString("\n\n")
        } finally {
            recognizer.close()
        }
    }

    private suspend fun recognize(
        context: Context,
        recognizer: com.google.mlkit.vision.text.TextRecognizer,
        page: Uri,
    ): String? {
        val image = runCatching { InputImage.fromFilePath(context, page) }.getOrNull() ?: return null
        return suspendCancellableCoroutine { continuation ->
            recognizer.process(image)
                .addOnSuccessListener { continuation.resume(it.text) }
                .addOnFailureListener { failure ->
                    Log.w("B4MCapture", "Text recognition failed on a scanned page", failure)
                    continuation.resume(null)
                }
        }
    }
}
