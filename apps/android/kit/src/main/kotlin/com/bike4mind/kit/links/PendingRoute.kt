package com.bike4mind.kit.links

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Owns an unconsumed in-app route (from a push or an app link) while authentication or screen restoration is
 * pending. [Route.Web] is never held: it needs no sign-in, so the host opens it at once.
 */
class PendingRoute {
    private val mutableRoute = MutableStateFlow<Route?>(null)
    val route: StateFlow<Route?> = mutableRoute.asStateFlow()

    /** A malformed or web route leaves the pending one alone. */
    fun accept(route: Route) {
        if (isHoldable(route)) mutableRoute.value = route
    }

    /** A restored empty state is authoritative; the old launch intent must not be replayed. */
    fun restore(saved: String?) {
        mutableRoute.value = saved?.let(::decode)?.takeIf(::isHoldable)
    }

    /** The pending route as a string for saved instance state, or null when nothing is pending. */
    fun snapshot(): String? = when (val pending = mutableRoute.value) {
        null -> null
        Route.Sessions -> SESSIONS
        is Route.Session -> SESSION + pending.sessionId
        is Route.Brief -> BRIEF + pending.briefId
        is Route.Web -> null
    }

    /** Acknowledging an older route must not discard a newer one. */
    fun consume(expected: Route): Boolean = mutableRoute.compareAndSet(expected, null)

    private fun isHoldable(route: Route): Boolean = when (route) {
        Route.Sessions -> true
        is Route.Session -> Route.isValidId(route.sessionId)
        is Route.Brief -> Route.isValidId(route.briefId)
        is Route.Web -> false
    }

    private fun decode(saved: String): Route? = when {
        saved == SESSIONS -> Route.Sessions
        saved.startsWith(SESSION) -> Route.Session(saved.removePrefix(SESSION))
        saved.startsWith(BRIEF) -> Route.Brief(saved.removePrefix(BRIEF))
        else -> null
    }

    private companion object {
        const val SESSIONS = "sessions"
        const val SESSION = "session:"
        const val BRIEF = "brief:"
    }
}
