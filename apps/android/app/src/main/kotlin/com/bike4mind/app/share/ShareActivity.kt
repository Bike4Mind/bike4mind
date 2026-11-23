package com.bike4mind.app.share

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.content.IntentCompat
import com.bike4mind.app.B4MApplication
import com.bike4mind.app.MainActivity
import com.bike4mind.app.R
import com.bike4mind.app.capture.CaptureFiles
import com.bike4mind.app.capture.CaptureWorker
import com.bike4mind.app.ui.B4MTheme
import com.bike4mind.kit.capture.IncomingFile
import kotlinx.coroutines.launch

/** What another app handed over: text (often a link) and any number of files. */
class SharedContent(val text: String?, val files: List<IncomingFile>) {
    val isEmpty get() = text.isNullOrBlank() && files.isEmpty()
}

/**
 * "Share to Bike4Mind". Copies what was shared into a capture job and leaves the sending to CaptureWorker, so
 * the share finishes after this activity is gone. Twin of apps/ios ShareExtension.
 */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as B4MApplication
        val content = read(intent)
        setContent {
            B4MTheme {
                Surface(
                    modifier = Modifier.fillMaxSize().semantics { testTagsAsResourceId = true },
                    color = MaterialTheme.colorScheme.background,
                ) {
                    ShareScreen(
                        app = app,
                        content = content,
                        onSent = {
                            app.scope.launch { CaptureWorker.schedule(app) }
                            Toast.makeText(this, R.string.share_sending, Toast.LENGTH_SHORT).show()
                            finish()
                        },
                        onOpenApp = {
                            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            finish()
                        },
                        onCancel = ::finish,
                    )
                }
            }
        }
    }

    private fun read(intent: Intent): SharedContent {
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()?.ifEmpty { null }
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE ->
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList()
        }
        val files = uris.filter(::isForeignContent).map { uri ->
            val type = CaptureFiles.mimeType(contentResolver, uri, intent.type)
            IncomingFile(CaptureFiles.fileName(contentResolver, uri, type), type) {
                contentResolver.openInputStream(uri) ?: error("Nothing to read at the shared URI")
            }
        }
        return SharedContent(text, files)
    }

    /**
     * Only another app's content: this activity is exported and reads with this app's identity, so a file:// path
     * or a URI from one of this app's own providers would hand its private files to whoever sent the intent.
     */
    private fun isForeignContent(uri: Uri): Boolean {
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) return false
        val authority = uri.authority ?: return false
        val owner = packageManager.resolveContentProvider(authority, 0)?.packageName ?: return false
        return owner != packageName
    }
}
