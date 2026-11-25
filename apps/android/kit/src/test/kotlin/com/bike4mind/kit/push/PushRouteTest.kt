package com.bike4mind.kit.push

import com.bike4mind.kit.links.Route
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PushRouteTest {
    private fun route(vararg data: Pair<String, String>, server: String? = null) =
        PushRoute.from(mapOf(*data)::get, server)

    @Test
    fun aBriefReadyPushRoutesToItsBrief() {
        assertEquals(
            Route.Brief("b1"),
            route("category" to "brief_ready", "briefId" to "b1", "deepLink" to "https://app.bike4mind.com/briefs/b2"),
        )
    }

    @Test
    fun aBriefReadyPushWithoutAUsableIdFallsBackToItsDeepLink() {
        assertNull(route("category" to "brief_ready"))
        assertEquals(
            Route.Brief("b2"),
            route("category" to "brief_ready", "briefId" to "../x", "deepLink" to "https://app.bike4mind.com/briefs/b2"),
        )
    }

    @Test
    fun aChatPushOpensTheChatFromItsDeepLink() {
        assertEquals(
            Route.Session("s1"),
            route("category" to "chat_completed", "deepLink" to "https://app.bike4mind.com/notebooks/s1", "sessionId" to "s9"),
        )
    }

    @Test
    fun aDeepLinkOnTheConfiguredServerRoutes() {
        assertEquals(
            Route.Session("s1"),
            route(
                "deepLink" to "https://app.staging.bike4mind.com/notebooks/s1",
                server = "https://app.staging.bike4mind.com",
            ),
        )
    }

    @Test
    fun aMissingOrForeignDeepLinkFallsBackToTheSessionId() {
        assertEquals(Route.Session("s2"), route("sessionId" to "s2"))
        assertEquals(Route.Session("s3"), route("deepLink" to "https://evil.example/x", "sessionId" to "s3"))
    }

    @Test
    fun aPushWithNothingRoutableHasNoRoute() {
        assertNull(route())
        assertNull(route("category" to "chat_completed", "sessionId" to "../x"))
        assertNull(route("deepLink" to "not a url"))
    }
}
