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
import com.bike4mind.app.B4MApplication
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Which screen is up. The upgrade screen covers everything while the server refuses this build; the session
 * and tokens are left alone, so a lowered minimum (or the installed update) returns the user where they were.
 */
@Composable
fun AppRoot(app: B4MApplication, signInError: MutableStateFlow<String?>) {
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

    when {
        upgrade != null -> UpgradeScreen(minimumVersion = upgrade?.minimumVersion, recheck = graph::recheckUpgrade)
        !restored -> Unit
        !signedIn -> SignInScreen(app = app, graph = graph, signInError = signInError)
        openChat != null -> {
            BackHandler { openChat = null }
            ChatScreen(
                graph = graph,
                sessionId = openChat.takeUnless { it == NEW_CHAT },
                onBack = { openChat = null },
            )
        }
        else -> SessionListScreen(
            graph = graph,
            onOpen = { openChat = it },
            onNewChat = { openChat = NEW_CHAT },
        )
    }
}

private const val NEW_CHAT = ""
