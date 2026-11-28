package com.bike4mind.app.ui

import android.annotation.SuppressLint
import android.graphics.Color
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.bike4mind.kit.artifacts.ArtifactDocuments
import java.io.ByteArrayInputStream

/** What a hosted artifact page may do. Everything else is refused by [ArtifactWebView]'s client. */
internal enum class ArtifactWebAccess(val scripts: Boolean, val network: Boolean, val bundledDiagramScript: Boolean) {
    /** An interactive page: its scripts run and its https images, styles and CDN libraries load. */
    PAGE(scripts = true, network = true, bundledDiagramScript = false),

    /** A picture: nothing runs, nothing loads. */
    PICTURE(scripts = false, network = false, bundledDiagramScript = false),

    /** A diagram: only the bundled renderer runs. */
    DIAGRAM(scripts = true, network = false, bundledDiagramScript = true),
}

/**
 * Shows an artifact's HTML in a locked-down WebView. The content is untrusted, so: no file or content-provider
 * access, no JS bridge (nothing is exposed to the page), JavaScript only for the access levels that need it, no DOM
 * storage or cache, no cookies, and a null origin (no base URL) so the page shares nothing with the app or other
 * artifacts. Navigation is never followed in place: a tapped https link opens in a Custom Tab through [onOpenLink].
 * [html] comes from kit's ArtifactDocuments, which adds the page's Content-Security-Policy.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun ArtifactWebView(html: String, access: ArtifactWebAccess, onOpenLink: (String) -> Unit, modifier: Modifier = Modifier) {
    val openLink by rememberUpdatedState(onOpenLink)
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(Color.WHITE)
                with(settings) {
                    javaScriptEnabled = access.scripts
                    allowFileAccess = false
                    allowContentAccess = false
                    @Suppress("DEPRECATION")
                    allowFileAccessFromFileURLs = false
                    @Suppress("DEPRECATION")
                    allowUniversalAccessFromFileURLs = false
                    domStorageEnabled = false
                    javaScriptCanOpenWindowsAutomatically = false
                    setSupportMultipleWindows(false)
                    setGeolocationEnabled(false)
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    cacheMode = WebSettings.LOAD_NO_CACHE
                    safeBrowsingEnabled = true
                    builtInZoomControls = true
                    displayZoomControls = false
                    useWideViewPort = true
                    loadWithOverviewMode = true
                }
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                webViewClient = ArtifactWebViewClient(access) { openLink(it) }
                loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            }
        },
        onRelease = { webView ->
            webView.stopLoading()
            webView.destroy()
        },
    )
}

private class ArtifactWebViewClient(private val access: ArtifactWebAccess, private val onOpenLink: (String) -> Unit) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (access.bundledDiagramScript && url.scheme == "https" && url.host == ArtifactDocuments.ASSET_HOST && url.path == "/mermaid.min.js") {
            return WebResourceResponse("application/javascript", "utf-8", view.context.assets.open("mermaid.min.js"))
        }
        // The page itself is loaded as a data: URL (no base URL), which this client sees too.
        if (url.scheme == "data" || url.scheme == "about") return null
        // The page policy already limits what a page may ask for; this also refuses cleartext and every other scheme.
        if (access.network && url.scheme == "https") return null
        return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (request.hasGesture() && request.url.scheme == "https") onOpenLink(request.url.toString())
        return true
    }
}
