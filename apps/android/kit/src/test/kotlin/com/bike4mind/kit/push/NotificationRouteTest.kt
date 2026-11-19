package com.bike4mind.kit.push

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class NotificationRouteTest {
    private fun route(vararg data: Pair<String, String>) = NotificationRoute.from(mapOf(*data)::get)

    @Test
    fun aBriefReadyPushRoutesToItsBrief() {
        assertEquals(
            NotificationRoute.Brief("b1"),
            route("category" to "brief_ready", "briefId" to "b1", "deepLink" to "https://app.example.test/briefs/b1"),
        )
    }

    @Test
    fun aBriefReadyPushWithoutAUsableIdRoutesNowhere() {
        assertNull(route("category" to "brief_ready"))
        assertNull(route("category" to "brief_ready", "briefId" to "../x"))
    }

    @Test
    fun otherCategoriesRouteNowhereYet() {
        assertNull(route("category" to "chat_completed", "briefId" to "b1"))
        assertNull(route())
    }
}
