package com.bike4mind.kit.auth

import com.bike4mind.kit.environment.ServerEnvironment

/**
 * The OAuth client this build signs in as. Each (clientId, redirectUri) pair must match a registered OAuth
 * client row on the server exactly (apps/client/pages/api/oauth/token.ts `validateClient`).
 */
data class OAuthConfiguration(val clientId: String, val redirectUri: String, val scope: String = "openid email profile") {
    companion object {
        /**
         * Non-production servers: the first-party native dev client (NATIVE_DEV_OAUTH_CLIENT_ID in
         * b4m-core/common/src/constants/oauthClients.ts). Its custom-scheme redirect is registered on Android by
         * the app's manifest intent filter, so debug builds sign in against staging and previews with no server change.
         */
        val nonProduction = OAuthConfiguration(
            clientId = "b4m-ios-app-dev",
            redirectUri = "com.bike4mind.app://auth-callback",
        )

        /**
         * Production needs an Android client row with a verified App Link redirect (assetlinks.json); until the
         * server registers one, production sign-in is refused with `unauthorized_client`.
         */
        val production = OAuthConfiguration(
            clientId = "b4m-android-app",
            redirectUri = "https://app.bike4mind.com/android/auth-callback",
        )

        fun forEnvironment(environment: ServerEnvironment): OAuthConfiguration =
            if (environment == ServerEnvironment.Production) production else nonProduction
    }
}
