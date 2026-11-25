package com.bike4mind.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.bike4mind.app.R
import com.bike4mind.kit.onboarding.Onboarding
import com.bike4mind.kit.onboarding.OnboardingPage
import kotlinx.coroutines.launch

/**
 * The first-launch welcome: what the app is, why notifications help, then on to sign-in. Twin of apps/ios
 * Features/Onboarding/OnboardingView.swift; the test tags match its accessibility identifiers.
 */
@Composable
fun OnboardingScreen(onFinish: () -> Unit) {
    val pages = Onboarding.pages
    val pager = rememberPagerState { pages.size }
    val scope = rememberCoroutineScope()
    val isLastPage = pager.currentPage == pages.lastIndex

    BackHandler(enabled = pager.currentPage > 0) {
        scope.launch { pager.animateScrollToPage(pager.currentPage - 1) }
    }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.widthIn(max = CONTENT_MAX_WIDTH).fillMaxSize().safeDrawingPadding().padding(Spacing.l),
            verticalArrangement = Arrangement.spacedBy(Spacing.l),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            HorizontalPager(state = pager, modifier = Modifier.weight(1f).fillMaxWidth()) { index ->
                OnboardingPageContent(pages[index])
            }
            PageIndicator(count = pages.size, current = pager.currentPage)
            Button(
                modifier = Modifier.fillMaxWidth().heightIn(min = BUTTON_MIN_HEIGHT).testTag("onboarding-next-btn"),
                onClick = {
                    if (isLastPage) onFinish() else scope.launch { pager.animateScrollToPage(pager.currentPage + 1) }
                },
            ) {
                Text(stringResource(if (isLastPage) R.string.onboarding_continue else R.string.onboarding_next))
            }
        }
    }
}

@Composable
private fun OnboardingPageContent(page: OnboardingPage) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = Spacing.xxl)
            .testTag("onboarding-page-${page.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.l, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            painter = painterResource(page.icon()),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(ICON_SIZE),
        )
        Text(
            page.title,
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            page.message,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun PageIndicator(count: Int, current: Int) {
    val description = stringResource(R.string.onboarding_page_indicator, current + 1, count)
    Row(
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        modifier = Modifier.clearAndSetSemantics { contentDescription = description },
    ) {
        repeat(count) { index ->
            val color = if (index == current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
            Box(Modifier.size(DOT_SIZE).background(color, CircleShape))
        }
    }
}

private val CONTENT_MAX_WIDTH = 600.dp
private val BUTTON_MIN_HEIGHT = 48.dp
private val ICON_SIZE = 64.dp
private val DOT_SIZE = 8.dp

private fun OnboardingPage.icon(): Int = when (id) {
    "notifications" -> R.drawable.ic_onboarding_notifications
    else -> R.drawable.ic_onboarding_welcome
}
