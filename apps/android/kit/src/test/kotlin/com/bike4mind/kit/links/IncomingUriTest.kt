package com.bike4mind.kit.links

import com.bike4mind.kit.auth.OAuthConfiguration
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class IncomingUriTest {
    private val production = OAuthConfiguration.production
    private val nonProduction = OAuthConfiguration.nonProduction

    @Test
    fun theProductionRedirectIsASignInCallbackNotAnAppLink() {
        for (uri in listOf(
            "https://app.bike4mind.com/android/auth-callback?code=c1&state=s1",
            "https://app.bike4mind.com/android/auth-callback/?error=access_denied&state=s1",
            "https://APP.bike4mind.com/android/auth-callback?code=c1&state=s1",
        )) {
            assertEquals(IncomingUri.SignInCallback, IncomingUri.classify(uri, production, "https://app.bike4mind.com"), uri)
        }
    }

    @Test
    fun theDebugRedirectIsASignInCallback() {
        assertEquals(
            IncomingUri.SignInCallback,
            IncomingUri.classify("com.bike4mind.app://auth-callback?code=c1&state=s1", nonProduction, null),
        )
    }

    @Test
    fun appLinksStillRouteUnderEitherConfiguration() {
        for (oauth in listOf(production, nonProduction)) {
            assertEquals(
                IncomingUri.Link(Route.Session("s1")),
                IncomingUri.classify("https://app.bike4mind.com/notebooks/s1", oauth, null),
            )
        }
    }

    @Test
    fun aRedirectForAnotherConfigurationIsNotTakenForThisOne() {
        val prodRedirect = "https://app.bike4mind.com/android/auth-callback?code=c1&state=s1"
        assertEquals(IncomingUri.Link(Route.Web(prodRedirect)), IncomingUri.classify(prodRedirect, nonProduction, null))
        assertNull(IncomingUri.classify("com.bike4mind.app://auth-callback?code=c1", production, null))
    }

    @Test
    fun redirectMatchingIgnoresTheQueryButNotThePath() {
        assertTrue(production.isRedirect("https://app.bike4mind.com/android/auth-callback"))
        assertFalse(production.isRedirect("https://app.bike4mind.com/android/auth-callback-other"))
        assertFalse(production.isRedirect("https://app.bike4mind.com/notebooks/s1"))
        assertFalse(production.isRedirect("http://app.bike4mind.com/android/auth-callback"))
        assertFalse(production.isRedirect("not a uri"))
    }
}
