package com.bike4mind.kit.shortcuts

import com.bike4mind.kit.links.Route
import kotlinx.coroutines.CancellationException

/** Where a [Route.Compose] opens once the notebook it names is known. */
sealed interface ComposeLanding {
    /** [sessionId] null is a new conversation. */
    data class Chat(val sessionId: String?, val draft: String) : ComposeLanding

    /** No notebook to open, or the list could not be read: the user picks one there. */
    data object Sessions : ComposeLanding

    companion object {
        /** [latestSessionId] is asked only for [Route.ComposeTarget.LATEST_SESSION]. */
        suspend fun of(route: Route.Compose, latestSessionId: suspend () -> String?): ComposeLanding =
            when (route.target) {
                Route.ComposeTarget.NEW_CONVERSATION -> Chat(null, route.draft)
                Route.ComposeTarget.LATEST_SESSION -> {
                    val id = try {
                        latestSessionId()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        null
                    }
                    id?.takeIf(Route::isValidId)?.let { Chat(it, route.draft) } ?: Sessions
                }
            }
    }
}
