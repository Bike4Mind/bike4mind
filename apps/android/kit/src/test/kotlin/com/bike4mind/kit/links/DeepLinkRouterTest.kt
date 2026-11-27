package com.bike4mind.kit.links

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Ported from apps/ios B4MKitTests/DeepLinkRouterTests.swift. */
class DeepLinkRouterTest {
    private fun route(url: String, server: String? = null) = DeepLinkRouter.route(url, server)

    @Test
    fun aBriefLinkRoutesToTheBrief() {
        assertEquals(Route.Brief("65f0c0ffee"), route("https://app.bike4mind.com/briefs/65f0c0ffee"))
    }

    @Test
    fun aMalformedOrBareBriefLinkFallsBackToTheWeb() {
        for (url in listOf("https://app.bike4mind.com/briefs/a%20b", "https://app.bike4mind.com/briefs")) {
            assertEquals(Route.Web(url), route(url))
        }
    }

    @Test
    fun sessionAndNotebookLinksRouteToTheChat() {
        assertEquals(Route.Session("65f0c0ffee"), route("https://app.bike4mind.com/sessions/65f0c0ffee"))
        assertEquals(Route.Session("65f0c0ffee"), route("https://app.bike4mind.com/notebooks/65f0c0ffee"))
    }

    @Test
    fun listLinksAndTheRootRouteToTheChatsList() {
        for (url in listOf(
            "https://app.bike4mind.com/notebooks",
            "https://app.bike4mind.com/sessions",
            "https://app.bike4mind.com/",
            "https://app.bike4mind.com",
        )) {
            assertEquals(Route.Sessions, route(url), url)
        }
    }

    @Test
    fun aNotebookPathWithASuffixStillOpensTheChat() {
        assertEquals(Route.Session("abc123"), route("https://app.bike4mind.com/notebooks/abc123/files"))
        assertEquals(Route.Session("abc123"), route("https://app.bike4mind.com/notebooks/abc123/?tab=chat"))
    }

    @Test
    fun aTrailingSlashQueryAndFragmentAreIgnored() {
        assertEquals(Route.Session("abc123"), route("https://app.bike4mind.com/sessions/abc123/"))
        assertEquals(Route.Session("abc123"), route("https://app.bike4mind.com/sessions/abc123?questId=9#top"))
    }

    @Test
    fun theHostIsCaseInsensitive() {
        assertEquals(Route.Session("abc"), route("https://APP.Bike4Mind.com/sessions/abc"))
    }

    @Test
    fun aMalformedIdFallsBackToTheWebInsteadOfNavigating() {
        for (url in listOf(
            "https://app.bike4mind.com/sessions/..%2F..%2Fadmin",
            "https://app.bike4mind.com/notebooks/..%2F..%2Fadmin",
        )) {
            assertEquals(Route.Web(url), route(url))
        }
    }

    @Test
    fun pagesWithNoAndroidScreenOpenOnTheWeb() {
        for (url in listOf(
            "https://app.bike4mind.com/pricing",
            "https://app.bike4mind.com/lakes/lake-1?tab=files",
            "https://app.bike4mind.com/media/xyz",
            "https://app.bike4mind.com/settings/notifications",
        )) {
            assertEquals(Route.Web(url), route(url))
        }
    }

    @Test
    fun otherHostsSchemesAndUserInfoAreRejected() {
        for (url in listOf(
            "https://evil.example.com/sessions/abc",
            "https://app.bike4mind.com.evil.example/sessions/abc",
            "https://bike4mind.com/sessions/abc",
            "http://app.bike4mind.com/sessions/abc",
            "bike4mind://sessions/abc",
            "https://app.bike4mind.com@evil.example/sessions/abc",
            "https://user:pw@app.bike4mind.com/sessions/abc",
            "not a url",
            "/sessions/abc",
        )) {
            assertNull(route(url), url)
        }
    }

    @Test
    fun theConfiguredServersOwnLinksAreAccepted() {
        val staging = "https://app.staging.bike4mind.com"
        assertEquals(Route.Session("s1"), route("https://app.staging.bike4mind.com/notebooks/s1", staging))
        assertNull(route("https://app.staging.bike4mind.com/notebooks/s1"))
        // A local server from the emulator: scheme, host and port must all match.
        val local = "http://10.0.2.2:3000"
        assertEquals(Route.Brief("b1"), route("http://10.0.2.2:3000/briefs/b1", local))
        assertNull(route("http://10.0.2.2:4000/briefs/b1", local))
        assertNull(route("https://10.0.2.2:3000/briefs/b1", local))
    }
}
