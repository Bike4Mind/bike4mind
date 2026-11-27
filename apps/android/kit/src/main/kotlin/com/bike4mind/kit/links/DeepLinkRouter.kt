package com.bike4mind.kit.links

import java.net.URI
import java.net.URISyntaxException

/**
 * Maps Bike4Mind web URLs (app links, push `deepLink`s) to in-app routes. Pure, so the whole matrix is unit-tested.
 * Twin of apps/ios B4MKit/Links/DeepLinkRouter.swift; keep the path table in step with it.
 */
object DeepLinkRouter {
    /** The only host the manifest claims for app links. */
    const val APP_HOST = "app.bike4mind.com"

    /**
     * @param serverBaseUrl the server this build talks to. Its own links are accepted too, because a push `deepLink`
     *   is built from that server's URL (apps/workers sendPush.ts resolveDeepLink), e.g. staging's.
     * @return null for anything that is not a link to [APP_HOST] (https) or to [serverBaseUrl]. A link with no native
     *   screen becomes [Route.Web], so it opens in the browser instead of doing nothing.
     */
    fun route(url: String, serverBaseUrl: String? = null): Route? {
        val uri = parse(url) ?: return null
        if (uri.rawUserInfo != null || !isOurs(uri, serverBaseUrl)) return null

        val segments = uri.rawPath.orEmpty().split('/').filter { it.isNotEmpty() }
        val first = segments.firstOrNull()?.lowercase() ?: return Route.Sessions
        val id = segments.getOrNull(1)
        return when (first) {
            // The web app (and the server's push deep links) call a session a notebook.
            "sessions", "notebooks" -> when {
                id == null -> Route.Sessions
                Route.isValidId(id) -> Route.Session(id)
                else -> Route.Web(url)
            }
            "briefs" -> if (id != null && Route.isValidId(id)) Route.Brief(id) else Route.Web(url)
            // iOS has lakes, media and settings screens; Android does not yet.
            else -> Route.Web(url)
        }
    }

    private fun parse(url: String): URI? = try {
        URI(url).takeIf { it.isAbsolute && it.host != null }
    } catch (_: URISyntaxException) {
        null
    }

    private fun isOurs(uri: URI, serverBaseUrl: String?): Boolean {
        val scheme = uri.scheme.lowercase()
        val host = uri.host.lowercase()
        if (scheme == "https" && host == APP_HOST && uri.port == -1) return true
        val server = serverBaseUrl?.let(::parse) ?: return false
        return scheme == server.scheme.lowercase() && host == server.host.lowercase() && uri.port == server.port
    }
}
