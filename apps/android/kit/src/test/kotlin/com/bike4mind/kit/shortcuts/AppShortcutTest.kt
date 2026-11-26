package com.bike4mind.kit.shortcuts

import com.bike4mind.kit.links.PendingRoute
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.links.Route.ComposeTarget
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class AppShortcutTest {
    private val session = "333333333333333333333333"

    @Test
    fun eachShortcutOpensItsComposer() {
        assertEquals(Route.Compose(ComposeTarget.NEW_CONVERSATION, ""), AppShortcut.fromAction("com.bike4mind.app.action.ASK")?.route)
        assertEquals(
            Route.Compose(ComposeTarget.NEW_CONVERSATION, "Save this note:\n\n"),
            AppShortcut.fromAction("com.bike4mind.app.action.CAPTURE_NOTE")?.route,
        )
        assertEquals(Route.Compose(ComposeTarget.LATEST_SESSION, ""), AppShortcut.fromAction("com.bike4mind.app.action.START_QUEST")?.route)
    }

    @Test
    fun anyOtherActionIsNotAShortcut() {
        for (action in listOf(null, "", "android.intent.action.MAIN", "android.intent.action.VIEW", "com.bike4mind.app.action.ask")) {
            assertNull(AppShortcut.fromAction(action), action)
        }
    }

    @Test
    fun aShortcutWaitsThroughSignInAndSurvivesRecreation() {
        for (shortcut in AppShortcut.entries) {
            val original = PendingRoute()
            original.accept(shortcut.route)
            val recreated = PendingRoute()
            recreated.restore(original.snapshot())

            assertEquals(shortcut.route, recreated.route.value)
            assertTrue(recreated.consume(shortcut.route))
        }
    }

    @Test
    fun aDraftWithSeparatorsRestoresIntact() {
        val route = Route.Compose(ComposeTarget.NEW_CONVERSATION, "a:b\n\ncompose:LATEST_SESSION:")
        val original = PendingRoute()
        original.accept(route)
        val recreated = PendingRoute()
        recreated.restore(original.snapshot())

        assertEquals(route, recreated.route.value)
    }

    @Test
    fun malformedComposeStateDoesNotCreateARoute() {
        for (saved in listOf("compose:", "compose:UNKNOWN:hi", "compose:NEW_CONVERSATION", "compose:new_conversation:")) {
            val pending = PendingRoute()
            pending.restore(saved)
            assertNull(pending.route.value, saved)
        }
    }

    @Test
    fun aNewConversationNeverReadsTheList() = runTest {
        val landing = ComposeLanding.of(AppShortcut.CAPTURE_NOTE.route) { error("not asked") }
        assertEquals(ComposeLanding.Chat(null, CAPTURE_NOTE_PREFIX), landing)
    }

    @Test
    fun startQuestOpensTheNewestNotebook() = runTest {
        assertEquals(ComposeLanding.Chat(session, ""), ComposeLanding.of(AppShortcut.START_QUEST.route) { session })
    }

    @Test
    fun startQuestFallsBackToTheChatsList() = runTest {
        val route = AppShortcut.START_QUEST.route
        assertEquals(ComposeLanding.Sessions, ComposeLanding.of(route) { null })
        assertEquals(ComposeLanding.Sessions, ComposeLanding.of(route) { throw IOException("offline") })
        assertEquals(ComposeLanding.Sessions, ComposeLanding.of(route) { "../other" })
    }
}
