package com.bike4mind.kit.environment

import java.net.URI

/** The backend the app talks to. Release builds are always [Production]; debug builds may pick a [Custom] URL. */
sealed interface ServerEnvironment {
    val baseUrl: String

    /** The server's host name, which keeps each server's caches and stores on disk apart. */
    val host: String
        get() = runCatching { URI(baseUrl).host }.getOrNull() ?: "default"

    data object Production : ServerEnvironment {
        override val baseUrl = "https://app.bike4mind.com"
    }

    /** Staging, a preview, or a local server: any http(s) origin, without a trailing slash. */
    data class Custom(override val baseUrl: String) : ServerEnvironment {
        init {
            require(baseUrl.startsWith("https://") || baseUrl.startsWith("http://")) { "Not an http(s) URL: $baseUrl" }
            require(!baseUrl.endsWith("/")) { "Drop the trailing slash: $baseUrl" }
        }
    }
}
