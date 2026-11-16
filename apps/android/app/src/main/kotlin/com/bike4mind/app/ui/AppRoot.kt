package com.bike4mind.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bike4mind.app.AppGraph
import com.bike4mind.app.B4MApplication
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Which screen is up. The upgrade screen covers everything while the server refuses this build; the session
 * and tokens are left alone, so a lowered minimum (or the installed update) returns the user where they were.
 */
@Composable
fun AppRoot(app: B4MApplication, signInError: MutableStateFlow<String?>, onSignedIn: () -> Unit = {}) {
    val graph = app.graph.collectAsStateWithLifecycle().value ?: return
    val upgrade by graph.upgradeSignal.notice.collectAsStateWithLifecycle()
    val signedIn by graph.session.isSignedIn.collectAsStateWithLifecycle()
    var restored by remember(graph) { mutableStateOf(false) }
    // A chat is identified by its session id; NEW_CHAT is a conversation the first message will create.
    var openChat by rememberSaveable(graph) { mutableStateOf<String?>(null) }

    LaunchedEffect(graph) {
        graph.session.restore()
        restored = true
    }

    // Push registration follows the session; [onSignedIn] is where the host asks for the notification permission.
    LaunchedEffect(graph, signedIn) {
        if (signedIn) {
            onSignedIn()
            graph.startPush()
        } else {
            graph.push.sessionDidEnd()
        }
    }

    // The upgrade screen leaves the current screen's view models alone, so the user returns to them intact.
    when {
        upgrade != null -> UpgradeScreen(minimumVersion = upgrade?.minimumVersion, recheck = graph::recheckUpgrade)
        !restored -> Unit
        !signedIn -> ScreenScope(key = Screen.SignIn(graph)) {
            SignInScreen(app = app, graph = graph, signInError = signInError)
        }
        openChat != null -> ScreenScope(key = Screen.Chat(graph, openChat)) {
            BackHandler { openChat = null }
            ChatScreen(
                graph = graph,
                sessionId = openChat.takeUnless { it == NEW_CHAT },
                onBack = { openChat = null },
            )
        }
        else -> ScreenScope(key = Screen.Sessions(graph)) {
            SessionListScreen(
                graph = graph,
                onOpen = { openChat = it },
                onNewChat = { openChat = NEW_CHAT },
            )
        }
    }
}

/** Screen identities for [ScreenScope]; the graph is part of each, so a server switch starts fresh. */
private sealed interface Screen {
    data class SignIn(val graph: AppGraph) : Screen
    data class Chat(val graph: AppGraph, val chat: String?) : Screen
    data class Sessions(val graph: AppGraph) : Screen
}

private const val NEW_CHAT = ""
