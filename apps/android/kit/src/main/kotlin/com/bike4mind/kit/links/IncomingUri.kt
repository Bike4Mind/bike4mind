package com.bike4mind.kit.links

import com.bike4mind.kit.auth.OAuthConfiguration

/** What the data URI of an intent that opened the app is for. */
sealed interface IncomingUri {
    /** The OAuth redirect of a sign-in this build may have started. */
    data object SignInCallback : IncomingUri

    data class Link(val route: Route) : IncomingUri

    companion object {
        /**
         * The redirect is checked first, by the configured [OAuthConfiguration.redirectUri] rather than by scheme:
         * the production redirect is an https App Link on app.bike4mind.com, which the link router would otherwise
         * send to the browser together with the authorization code.
         *
         * @return null for a URI that is neither (the app just opens).
         */
        fun classify(uri: String, oauth: OAuthConfiguration, serverBaseUrl: String?): IncomingUri? =
            if (oauth.isRedirect(uri)) SignInCallback else DeepLinkRouter.route(uri, serverBaseUrl)?.let(::Link)
    }
}
