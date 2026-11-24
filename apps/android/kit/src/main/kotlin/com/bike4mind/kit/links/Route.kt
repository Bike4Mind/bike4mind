package com.bike4mind.kit.links

/**
 * A destination inside the app, from an app link or a tapped push. Twin of apps/ios B4MKit/Links/Route.swift,
 * narrowed to the screens Android has: anything else is [Web].
 */
sealed interface Route {
    /** The chats list, which is also the app's start screen. */
    data object Sessions : Route

    data class Session(val sessionId: String) : Route

    data class Brief(val briefId: String) : Route

    /** A Bike4Mind page with no native screen: opened in the browser rather than dropped. */
    data class Web(val url: String) : Route

    companion object {
        /**
         * Same rule as apps/ios DeepLinkRouter.isValidIdentifier: Mongo ids today, any conservative slug tomorrow,
         * never path punctuation.
         */
        fun isValidId(id: String): Boolean = ID.matches(id)

        private val ID = Regex("[A-Za-z0-9_-]{1,64}")
    }
}
