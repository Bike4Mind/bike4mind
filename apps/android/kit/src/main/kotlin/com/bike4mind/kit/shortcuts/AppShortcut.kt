package com.bike4mind.kit.shortcuts

import com.bike4mind.kit.links.Route
import com.bike4mind.kit.links.Route.ComposeTarget

/**
 * The launcher's static shortcuts (app/src/main/res/xml/shortcuts.xml; each [action] there must match). Twin of
 * apps/ios AssistantRequest, without its parameters: a static shortcut carries no prompt or notebook, so Ask opens an
 * empty composer, Capture note one with the note prefix, and Start quest the newest notebook.
 */
enum class AppShortcut(val action: String, val route: Route.Compose) {
    ASK("com.bike4mind.app.action.ASK", Route.Compose(ComposeTarget.NEW_CONVERSATION)),
    CAPTURE_NOTE("com.bike4mind.app.action.CAPTURE_NOTE", Route.Compose(ComposeTarget.NEW_CONVERSATION, CAPTURE_NOTE_PREFIX)),
    START_QUEST("com.bike4mind.app.action.START_QUEST", Route.Compose(ComposeTarget.LATEST_SESSION)),
    ;

    companion object {
        fun fromAction(action: String?): AppShortcut? = entries.firstOrNull { it.action == action }
    }
}

/** Same words as apps/ios AssistantRequest.captureNotePrefix: tells the assistant what to do with the note. */
const val CAPTURE_NOTE_PREFIX = "Save this note:\n\n"
