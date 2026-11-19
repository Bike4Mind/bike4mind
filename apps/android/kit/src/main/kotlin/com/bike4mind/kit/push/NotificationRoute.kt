package com.bike4mind.kit.push

import com.bike4mind.kit.briefs.BriefWire

/** Where tapping a push should land. Only categories with a screen of their own route anywhere. */
sealed interface NotificationRoute {
    data class Brief(val briefId: String) : NotificationRoute

    companion object {
        /**
         * Reads the FCM `data` map (apps/workers/src/events/sendPush.ts buildFcmMessage). It reaches the app as the
         * message's data while in the foreground, and as the launch intent's extras after a system-tray tap.
         * A malformed id routes nowhere, so the tap just opens the app.
         */
        fun from(data: (String) -> String?): NotificationRoute? = when (data("category")) {
            "brief_ready" -> data("briefId")?.takeIf(BriefWire::isValidId)?.let(::Brief)
            else -> null
        }
    }
}
