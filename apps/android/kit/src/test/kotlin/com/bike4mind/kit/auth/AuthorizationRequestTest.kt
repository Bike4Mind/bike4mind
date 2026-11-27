package com.bike4mind.kit.auth

import com.bike4mind.kit.environment.ServerEnvironment
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AuthorizationRequestTest {
    private val request = AuthorizationRequest(
        ServerEnvironment.Custom("https://staging.example.test"),
        OAuthConfiguration.nonProduction,
        verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        state = "state-1",
    )

    @Test
    fun challengeMatchesTheRfc7636Vector() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    @Test
    fun generatedSecretsAreUrlSafe() {
        val verifier = Pkce.verifier()
        assertTrue(verifier.length >= 43 && verifier.all { it.isLetterOrDigit() || it == '-' || it == '_' }, verifier)
    }

    @Test
    fun authorizeUrlCarriesEveryParameter() {
        assertEquals(
            "https://staging.example.test/oauth/authorize?response_type=code&client_id=b4m-ios-app-dev" +
                "&redirect_uri=com.bike4mind.app%3A%2F%2Fauth-callback&scope=openid%20email%20profile&state=state-1" +
                "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256",
            request.url,
        )
    }

    @Test
    fun callbackYieldsTheCode() {
        assertEquals(AuthorizationResult.Code("abc"), request.result("com.bike4mind.app://auth-callback?code=abc&state=state-1"))
    }

    @Test
    fun deniedAndErrorsAreDistinguished() {
        assertEquals(AuthorizationResult.Denied, request.result("com.bike4mind.app://auth-callback?error=access_denied&state=state-1"))
        assertEquals(
            AuthorizationResult.Failed("server_error"),
            request.result("com.bike4mind.app://auth-callback?error=server_error&state=state-1"),
        )
    }

    @Test
    fun foreignOrStaleCallbacksAreIgnored() {
        assertNull(request.result("com.bike4mind.app://auth-callback?code=abc&state=another-attempt"))
        assertNull(request.result("com.bike4mind.app://elsewhere?code=abc&state=state-1"))
        assertNull(request.result("https://evil.example.test/auth-callback?code=abc&state=state-1"))
    }

    @Test
    fun productionUsesTheProductionClient() {
        assertEquals(OAuthConfiguration.production, OAuthConfiguration.forEnvironment(ServerEnvironment.Production))
        assertEquals(
            OAuthConfiguration.nonProduction,
            OAuthConfiguration.forEnvironment(ServerEnvironment.Custom("https://pr1.preview.example.test")),
        )
    }
}
