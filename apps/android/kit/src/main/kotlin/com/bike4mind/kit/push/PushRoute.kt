package com.bike4mind.kit.push

import com.bike4mind.kit.links.DeepLinkRouter
import com.bike4mind.kit.links.Route

/** Where tapping a push should land. Twin of apps/ios NotificationPayload.route. */
object PushRoute {
    /**
     * Reads the FCM `data` map (apps/workers/src/events/sendPush.ts buildFcmMessage). It reaches the app as the
     * message's data while in the foreground, and as the launch intent's extras after a system-tray tap.
     *
     * A `brief_ready` push opens its brief; otherwise the `deepLink` when it routes, else the `sessionId`. With
     * nothing usable the tap just opens the app.
     */
    fun from(data: (String) -> String?, serverBaseUrl: String?): Route? {
        if (data("category") == "brief_ready") {
            data("briefId")?.takeIf(Route::isValidId)?.let { return Route.Brief(it) }
        }
        data("deepLink")?.let { DeepLinkRouter.route(it, serverBaseUrl) }?.let { return it }
        return data("sessionId")?.takeIf(Route::isValidId)?.let(Route::Session)
    }
}
