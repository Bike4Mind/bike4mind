package com.bike4mind.app.ui

import android.graphics.Bitmap
import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.app.media.MediaImageLoader
import com.bike4mind.kit.media.MediaDetailController
import com.bike4mind.kit.media.MediaKind
import java.io.IOException
import kotlinx.coroutines.CancellationException

/**
 * One generated file full screen: a zoomable image, or a video/audio player. Storage URLs are short-lived, so the
 * controller refetches the detail when one lapses or fails to load. Twin of apps/ios Features/Media/MediaDetailView.swift.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MediaDetailScreen(graph: AppGraph, controller: MediaDetailController, onBack: () -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    val shown = state.item

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(shown.displayTitle ?: kindName(shown.kind), maxLines = 1) },
                navigationIcon = { TextButton(onClick = onBack, modifier = Modifier.testTag("media-detail-back-btn")) { Text(stringResource(R.string.action_back)) } },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding).testTag("media-detail"), contentAlignment = Alignment.Center) {
            val url = state.playableUrl
            val error = state.error
            when {
                state.refreshing -> CircularProgressIndicator(modifier = Modifier.testTag("media-detail-loading"))
                error != null -> Notice(
                    title = stringResource(R.string.media_open_failed),
                    body = errorMessage(error),
                    tag = "media-detail-error",
                    action = stringResource(R.string.action_try_again) to controller::retry,
                    actionTag = "media-detail-retry-btn",
                )
                url == null -> Notice(
                    title = stringResource(R.string.media_processing_title),
                    body = stringResource(R.string.media_processing_body),
                    tag = "media-detail-processing",
                )
                // Keyed on the URL: a refetched one starts a fresh loader or player.
                else -> key(url) {
                    when (shown.kind) {
                        MediaKind.IMAGE -> ZoomableImage(url, graph.mediaImages, onLoaded = controller::playbackSucceeded, onFailed = controller::playbackFailed)
                        MediaKind.VIDEO, MediaKind.AUDIO -> Player(url, onReady = controller::playbackSucceeded, onFailed = controller::playbackFailed)
                    }
                }
            }
        }
    }
}

@Composable
private fun ZoomableImage(url: String, images: MediaImageLoader, onLoaded: () -> Unit, onFailed: () -> Unit) {
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    val loaded by rememberUpdatedState(onLoaded)
    val failed by rememberUpdatedState(onFailed)
    LaunchedEffect(url) {
        try {
            bitmap = images.full(url)
            loaded()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: IOException) {
            failed()
        }
    }

    val image = bitmap
    if (image == null) {
        CircularProgressIndicator(modifier = Modifier.testTag("media-detail-loading"))
        return
    }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val transform = rememberTransformableState { _, zoom, pan, _ ->
        scale = (scale * zoom).coerceIn(MIN_ZOOM, MAX_ZOOM)
        offset = if (scale == MIN_ZOOM) Offset.Zero else offset + pan
    }
    Image(
        bitmap = image.asImageBitmap(),
        contentDescription = null,
        contentScale = ContentScale.Fit,
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                // Double tap toggles between fit and a closer look, as the iOS viewer does.
                detectTapGestures(onDoubleTap = {
                    scale = if (scale > MIN_ZOOM) MIN_ZOOM else DOUBLE_TAP_ZOOM
                    offset = Offset.Zero
                })
            }
            .transformable(transform)
            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y)
            .testTag("media-detail-image"),
    )
}

/** The platform player with its own controls; audio plays through the same view with the controls pinned. */
@Composable
private fun Player(url: String, onReady: () -> Unit, onFailed: () -> Unit) {
    val ready by rememberUpdatedState(onReady)
    val failed by rememberUpdatedState(onFailed)
    AndroidView(
        modifier = Modifier.fillMaxSize().testTag("media-detail-player"),
        factory = { context ->
            VideoView(context).apply {
                val controls = MediaController(context)
                controls.setAnchorView(this)
                setMediaController(controls)
                setOnPreparedListener {
                    start()
                    controls.show(0)
                    // Prepared is not played: a codec the device lacks fails right after, so count it once playback runs.
                    postDelayed({ if (isPlaying && currentPosition > 0) ready() }, PLAYBACK_PROOF_MS)
                }
                setOnErrorListener { _, _, _ ->
                    failed()
                    true
                }
                setVideoURI(Uri.parse(url))
            }
        },
        onRelease = { it.stopPlayback() },
    )
}

private const val MIN_ZOOM = 1f
private const val PLAYBACK_PROOF_MS = 1_000L
private const val DOUBLE_TAP_ZOOM = 2.5f
private const val MAX_ZOOM = 5f
