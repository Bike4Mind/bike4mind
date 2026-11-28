package com.bike4mind.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bike4mind.app.AppGraph
import com.bike4mind.app.R
import com.bike4mind.kit.artifacts.ArtifactDetail
import com.bike4mind.kit.artifacts.ArtifactDetailState
import com.bike4mind.kit.artifacts.ArtifactDocuments
import com.bike4mind.kit.artifacts.ArtifactPresentation

class ArtifactDetailViewModel(graph: AppGraph, id: String) : ViewModel() {
    val controller = graph.artifactDetail(id, viewModelScope).also { it.load() }
}

/**
 * One artifact, drawn by type: pages, pictures and diagrams in a locked-down WebView, code and prose as selectable
 * text, and the types only the web app can draw (React, charts, games) as an "Open full version" fallback.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArtifactDetailScreen(graph: AppGraph, id: String, onBack: () -> Unit) {
    val model = viewModel(key = "artifact-$id") { ArtifactDetailViewModel(graph, id) }
    val state by model.controller.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val openFullVersion = { openInCustomTab(context, graph.artifactFullVersionUrl(id)) }
    val loaded = (state as? ArtifactDetailState.Loaded)?.detail

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(loaded?.summary?.title ?: stringResource(R.string.artifacts_title), maxLines = 1) },
                navigationIcon = { TextButton(onClick = onBack, modifier = Modifier.testTag("artifact-detail-back-btn")) { Text(stringResource(R.string.action_back)) } },
                actions = {
                    // The fallback screen carries its own button; every other type still offers the web app.
                    if (loaded != null && loaded.summary.type.presentation != ArtifactPresentation.FULL_VERSION_ONLY) {
                        TextButton(onClick = openFullVersion, modifier = Modifier.testTag("artifact-detail-open-web-btn")) {
                            Text(stringResource(R.string.artifacts_open_full_version))
                        }
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding).testTag("artifact-detail"), contentAlignment = Alignment.Center) {
            when (val current = state) {
                ArtifactDetailState.Loading -> CircularProgressIndicator(modifier = Modifier.testTag("artifact-detail-loading"))
                is ArtifactDetailState.Failed -> Notice(
                    title = stringResource(R.string.artifacts_open_failed),
                    body = errorMessage(current.error),
                    tag = "artifact-detail-error",
                    action = if (current.error.isRetryable) stringResource(R.string.action_try_again) to model.controller::retry else null,
                    actionTag = "artifact-detail-retry-btn",
                )
                is ArtifactDetailState.Loaded -> ArtifactBody(current.detail, openFullVersion, onOpenLink = { openInCustomTab(context, it) })
            }
        }
    }
}

@Composable
internal fun ArtifactBody(detail: ArtifactDetail, openFullVersion: () -> Unit, onOpenLink: (String) -> Unit) {
    val presentation = detail.summary.type.presentation
    val content = detail.content
    if (presentation == ArtifactPresentation.FULL_VERSION_ONLY) {
        Notice(
            title = stringResource(R.string.artifacts_full_version_title),
            body = stringResource(R.string.artifacts_full_version_body),
            tag = "artifact-detail-full-version",
            action = stringResource(R.string.artifacts_open_full_version) to openFullVersion,
            actionTag = "artifact-detail-open-full-btn",
        )
        return
    }
    if (content.isNullOrBlank()) {
        Notice(title = stringResource(R.string.artifacts_empty_content), body = null, tag = "artifact-detail-empty")
        return
    }
    when (presentation) {
        // Keyed on the content so a reload builds a fresh WebView.
        ArtifactPresentation.WEB_PAGE -> key(content) {
            ArtifactWebView(ArtifactDocuments.page(content), ArtifactWebAccess.PAGE, onOpenLink, Modifier.fillMaxSize().testTag("artifact-detail-web"))
        }
        ArtifactPresentation.IMAGE -> key(content) {
            ArtifactWebView(ArtifactDocuments.svg(content), ArtifactWebAccess.PICTURE, onOpenLink, Modifier.fillMaxSize().testTag("artifact-detail-web"))
        }
        ArtifactPresentation.DIAGRAM -> key(content) {
            ArtifactWebView(ArtifactDocuments.mermaid(content), ArtifactWebAccess.DIAGRAM, onOpenLink, Modifier.fillMaxSize().testTag("artifact-detail-web"))
        }
        ArtifactPresentation.TEXT, ArtifactPresentation.MARKDOWN -> SelectionContainer(modifier = Modifier.fillMaxSize()) {
            Text(
                text = content,
                style = if (presentation == ArtifactPresentation.TEXT) MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge,
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Spacing.m).testTag("artifact-detail-text"),
            )
        }
        ArtifactPresentation.FULL_VERSION_ONLY -> Unit
    }
}

private fun openInCustomTab(context: Context, url: String) {
    try {
        CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
    } catch (noBrowser: ActivityNotFoundException) {
        // A device with no browser has nowhere to send the link; the artifact itself stays on screen.
    }
}
