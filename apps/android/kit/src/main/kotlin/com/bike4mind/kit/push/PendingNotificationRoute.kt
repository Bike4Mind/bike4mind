package com.bike4mind.kit.push

import com.bike4mind.kit.briefs.BriefWire
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Owns an unconsumed push route while authentication or screen restoration is pending. */
class PendingNotificationRoute {
    private val mutableRoute = MutableStateFlow<NotificationRoute?>(null)
    val route: StateFlow<NotificationRoute?> = mutableRoute.asStateFlow()

    fun accept(route: NotificationRoute) {
        when (route) {
            is NotificationRoute.Brief -> if (BriefWire.isValidId(route.briefId)) mutableRoute.value = route
        }
    }

    /** A restored empty state is authoritative; the old launch intent must not be replayed. */
    fun restoreBriefId(briefId: String?) {
        mutableRoute.value = briefId?.takeIf(BriefWire::isValidId)?.let { NotificationRoute.Brief(it) }
    }

    fun snapshotBriefId(): String? = when (val pending = mutableRoute.value) {
        is NotificationRoute.Brief -> pending.briefId
        null -> null
    }

    /** Acknowledging an older route must not discard a newer push. */
    fun consume(expected: NotificationRoute): Boolean = mutableRoute.compareAndSet(expected, null)
}
