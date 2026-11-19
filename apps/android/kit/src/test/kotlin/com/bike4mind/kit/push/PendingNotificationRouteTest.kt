package com.bike4mind.kit.push

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PendingNotificationRouteTest {
    private val first = NotificationRoute.Brief("111111111111111111111111")
    private val second = NotificationRoute.Brief("222222222222222222222222")

    @Test
    fun anUnconsumedBriefSurvivesOwnerRecreationAndIsConsumedOnce() {
        val original = PendingNotificationRoute()
        original.accept(first)
        val savedId = original.snapshotBriefId()
        val recreated = PendingNotificationRoute()
        recreated.restoreBriefId(savedId)

        assertEquals(first, recreated.route.value)
        assertTrue(recreated.consume(first))
        assertFalse(recreated.consume(first))
        assertNull(recreated.route.value)
    }

    @Test
    fun aConsumedRouteRestoresEmptyWithoutReplayingTheLaunchRoute() {
        val original = PendingNotificationRoute()
        original.accept(first)
        original.consume(first)
        val recreated = PendingNotificationRoute()
        // Saved state is authoritative even when its value is null.
        recreated.restoreBriefId(original.snapshotBriefId())

        assertNull(recreated.route.value)
        assertNull(recreated.snapshotBriefId())
    }

    @Test
    fun acknowledgingAnOlderRouteKeepsANewerPushPending() {
        val pending = PendingNotificationRoute()
        pending.accept(first)
        pending.accept(second)

        assertFalse(pending.consume(first))
        assertEquals(second, pending.route.value)
        assertEquals(second.briefId, pending.snapshotBriefId())
        assertTrue(pending.consume(second))
    }

    @Test
    fun malformedSavedIdsDoNotCreateRoutes() {
        for (id in listOf("", "invalid/id", "../other-route")) {
            val pending = PendingNotificationRoute()
            pending.restoreBriefId(id)
            assertNull(pending.route.value)
        }
    }

    @Test
    fun aMalformedIncomingRouteDoesNotReplaceAValidPendingPush() {
        val pending = PendingNotificationRoute()
        pending.accept(first)
        pending.accept(NotificationRoute.Brief("invalid/id"))

        assertEquals(first, pending.route.value)
    }
}
