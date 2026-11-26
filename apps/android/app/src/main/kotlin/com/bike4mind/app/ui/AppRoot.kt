package com.bike4mind.app.ui

import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bike4mind.app.AppGraph
import com.bike4mind.app.B4MApplication
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.shortcuts.ComposeLanding
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Which screen is up. The upgrade screen covers everything while the server refuses this build; the session
 * and tokens are left alone, so a lowered minimum (or the installed update) returns the user where they were.
 */
@Composable
fun AppRoot(
    app: B4MApplication,
    signInError: MutableStateFlow<String?>,
    pendingRoute: StateFlow<Route?>,
    onRouteConsumed: (Route) -> Unit,
    onSignedIn: () -> Unit = {},
) {
    val graph = app.graph.collectAsStateWithLifecycle().value ?: return
    val upgrade by graph.upgradeSignal.notice.collectAsStateWithLifecycle()
    val signedIn by graph.session.isSignedIn.collectAsStateWithLifecycle()
    val onboardingCompleted by app.onboarding.isCompleted.collectAsStateWithLifecycle()
    val deletion by graph.deletionSignal.notice.collectAsStateWithLifecycle()
    var restored by remember(graph) { mutableStateOf(false) }
    // A chat is identified by its session id; NEW_CHAT is a conversation the first message will create.
    var openChat by rememberSaveable(graph) { mutableStateOf<String?>(null) }
    // The composer text a launcher shortcut opened [openChat] with; null for a chat opened any other way.
    var composeDraft by rememberSaveable(graph) { mutableStateOf<String?>(null) }
    // Bumped per shortcut so it always opens a fresh chat screen, even over the same chat.
    var chatLaunch by rememberSaveable(graph) { mutableIntStateOf(0) }
    // A brief id from a push or a link, or LATEST_BRIEF from the chats list.
    var openBrief by rememberSaveable(graph) { mutableStateOf<String?>(null) }
    // The Studio gallery, opened from the chats list.
    var openStudio by rememberSaveable(graph) { mutableStateOf(false) }
    // SETTINGS or DELETE_ACCOUNT while Settings is up.
    var openSettings by rememberSaveable(graph) { mutableStateOf<String?>(null) }
    val route by pendingRoute.collectAsStateWithLifecycle()

    fun showChat(sessionId: String?, draft: String? = null) {
        openSettings = null
        openStudio = false
        openBrief = null
        composeDraft = draft
        if (draft != null) chatLaunch++
        openChat = sessionId
    }

    LaunchedEffect(graph) {
        graph.session.restore()
        restored = true
    }

    // A sign-out made while offline is finished on the server once the app is back in front, and again when a
    // server switch brings in a graph whose pending revocations have not been tried yet.
    val scope = rememberCoroutineScope()
    fun retryPendingRevocations() {
        scope.launch {
            try {
                graph.session.retryPendingRevocations()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failed: Exception) {
                Log.w(TAG, "Retrying pending sign-out revocations failed", failed)
            }
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { retryPendingRevocations() }
    LaunchedEffect(graph) { retryPendingRevocations() }

    // A session that ends (a refresh refused, a sign-out elsewhere) drops what belonged to the account. Checked only
    // once restore has settled, so a signed-in cold start keeps the gallery's stale-first cache.
    LaunchedEffect(graph, restored, signedIn) {
        if (restored && !signedIn) graph.onSessionEnded()
    }

    // Push registration follows the session; [onSignedIn] is where the host asks for the notification permission.
    LaunchedEffect(graph, signedIn) {
        if (signedIn) {
            // Someone who got this far never needs the welcome, e.g. a session restored after an upgrade.
            app.onboarding.complete()
            onSignedIn()
            graph.startPush()
        } else {
            graph.push.sessionDidEnd()
            // A new session starts clean; a call that still finds the account pending raises it again.
            graph.deletionSignal.reset()
            openSettings = null
            openStudio = false
        }
    }

    // A tapped push or an app link waits here through sign-in, then replaces whatever screen was up.
    LaunchedEffect(graph, restored, signedIn, route) {
        val pending = route ?: return@LaunchedEffect
        if (!restored || !signedIn) return@LaunchedEffect
        when (pending) {
            Route.Sessions -> showChat(null)
            is Route.Session -> showChat(pending.sessionId)
            is Route.Brief -> {
                openSettings = null
                openStudio = false
                openChat = null
                openBrief = pending.briefId
            }
            is Route.Compose -> when (val landing = ComposeLanding.of(pending) { graph.sessions.list(limit = 1).sessions.firstOrNull()?.id }) {
                is ComposeLanding.Chat -> showChat(landing.sessionId ?: NEW_CHAT, landing.draft)
                ComposeLanding.Sessions -> showChat(null)
            }
            // MainActivity opens web routes itself; one never waits here.
            is Route.Web -> Unit
        }
        onRouteConsumed(pending)
    }

    // The upgrade screen leaves the current screen's view models alone, so the user returns to them intact.
    when {
        upgrade != null -> UpgradeScreen(minimumVersion = upgrade?.minimumVersion, recheck = graph::recheckUpgrade)
        !restored -> Unit
        !signedIn && !onboardingCompleted -> OnboardingScreen(onFinish = app.onboarding::complete)
        !signedIn -> ScreenScope(key = Screen.SignIn(graph)) {
            SignInScreen(app = app, graph = graph, signInError = signInError)
        }
        deletion != null -> ScreenScope(key = Screen.Restore(graph)) {
            AccountRestoreScreen(graph = graph, scheduledFor = deletion?.scheduledFor)
        }
        openSettings == DELETE_ACCOUNT -> ScreenScope(key = Screen.DeleteAccount(graph)) {
            BackHandler { openSettings = SETTINGS }
            DeleteAccountScreen(graph = graph, onBack = { openSettings = SETTINGS })
        }
        openSettings == SETTINGS -> ScreenScope(key = Screen.Settings(graph)) {
            BackHandler { openSettings = null }
            SettingsScreen(graph = graph, onBack = { openSettings = null }, onDeleteAccount = { openSettings = DELETE_ACCOUNT })
        }
        openBrief != null -> ScreenScope(key = Screen.Brief(graph, openBrief)) {
            BackHandler { openBrief = null }
            BriefScreen(
                graph = graph,
                briefId = openBrief.takeUnless { it == LATEST_BRIEF },
                onBack = { openBrief = null },
                onOpenSession = { showChat(it) },
            )
        }
        openStudio -> ScreenScope(key = Screen.Studio(graph)) {
            BackHandler { openStudio = false }
            MediaGalleryScreen(graph = graph, onBack = { openStudio = false })
        }
        openChat != null -> ScreenScope(key = Screen.Chat(graph, openChat, chatLaunch)) {
            // Keyed like the screen so its saved composer text starts over too.
            key(openChat, chatLaunch) {
                BackHandler { showChat(null) }
                ChatScreen(
                    graph = graph,
                    sessionId = openChat.takeUnless { it == NEW_CHAT },
                    onBack = { showChat(null) },
                    composeDraft = composeDraft,
                )
            }
        }
        else -> ScreenScope(key = Screen.Sessions(graph)) {
            SessionListScreen(
                graph = graph,
                onOpen = { showChat(it) },
                onNewChat = { showChat(NEW_CHAT) },
                onOpenBrief = { openBrief = LATEST_BRIEF },
                onOpenStudio = { openStudio = true },
                onOpenSettings = { openSettings = SETTINGS },
            )
        }
    }
}

/** Screen identities for [ScreenScope]; the graph is part of each, so a server switch starts fresh. */
private sealed interface Screen {
    data class SignIn(val graph: AppGraph) : Screen
    data class Chat(val graph: AppGraph, val chat: String?, val launch: Int) : Screen
    data class Brief(val graph: AppGraph, val brief: String?) : Screen
    data class Sessions(val graph: AppGraph) : Screen
    data class Settings(val graph: AppGraph) : Screen
    data class Studio(val graph: AppGraph) : Screen
    data class DeleteAccount(val graph: AppGraph) : Screen
    data class Restore(val graph: AppGraph) : Screen
}

private const val TAG = "B4MAuth"
private const val NEW_CHAT = ""
private const val LATEST_BRIEF = ""
private const val SETTINGS = "settings"
private const val DELETE_ACCOUNT = "delete-account"
