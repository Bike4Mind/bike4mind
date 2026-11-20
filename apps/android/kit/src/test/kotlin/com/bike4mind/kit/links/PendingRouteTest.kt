package com.bike4mind.kit.links

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PendingRouteTest {
    private val first = Route.Brief("111111111111111111111111")
    private val second = Route.Brief("222222222222222222222222")

    @Test
    fun anUnconsumedRouteSurvivesOwnerRecreationAndIsConsumedOnce() {
        for (route in listOf(first, Route.Session("333333333333333333333333"), Route.Sessions)) {
            val original = PendingRoute()
            original.accept(route)
            val recreated = PendingRoute()
            recreated.restore(original.snapshot())

            assertEquals(route, recreated.route.value)
            assertTrue(recreated.consume(route))
            assertFalse(recreated.consume(route))
            assertNull(recreated.route.value)
        }
    }

    @Test
    fun aConsumedRouteRestoresEmptyWithoutReplayingTheLaunchRoute() {
        val original = PendingRoute()
        original.accept(first)
        original.consume(first)
        val recreated = PendingRoute()
        // Saved state is authoritative even when its value is null.
        recreated.restore(original.snapshot())

        assertNull(recreated.route.value)
        assertNull(recreated.snapshot())
    }

    @Test
    fun acknowledgingAnOlderRouteKeepsANewerOnePending() {
        val pending = PendingRoute()
        pending.accept(first)
        pending.accept(second)

        assertFalse(pending.consume(first))
        assertEquals(second, pending.route.value)
        assertTrue(pending.consume(second))
    }

    @Test
    fun malformedSavedStateDoesNotCreateRoutes() {
        for (saved in listOf("", "brief:", "brief:invalid/id", "session:../other", "web:https://x", "unknown")) {
            val pending = PendingRoute()
            pending.restore(saved)
            assertNull(pending.route.value, saved)
        }
    }

    @Test
    fun malformedAndWebRoutesDoNotReplaceAValidPendingOne() {
        val pending = PendingRoute()
        pending.accept(first)
        pending.accept(Route.Brief("invalid/id"))
        pending.accept(Route.Session("../x"))
        pending.accept(Route.Web("https://app.bike4mind.com/pricing"))

        assertEquals(first, pending.route.value)
    }
}
