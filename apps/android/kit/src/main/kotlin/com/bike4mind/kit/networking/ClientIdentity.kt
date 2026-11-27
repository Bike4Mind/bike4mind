package com.bike4mind.kit.networking

/**
 * The build's declaration on every request and the socket upgrade: `X-Client-Name` / `X-Client-Version`.
 * The server compares the version against the admin-set minimum for [name] and answers 426 when it is older.
 * Twin of apps/ios ClientIdentity (`b4m-ios`); keep the version rule identical.
 */
data class ClientIdentity(val name: String, val version: String?) {
    /** Header pairs to stamp; empty when the build's version is not one the server can compare. */
    val headers: Map<String, String>
        get() = version?.let { mapOf(NAME_HEADER to name, VERSION_HEADER to it) } ?: emptyMap()

    companion object {
        const val NAME_HEADER = "X-Client-Name"
        const val VERSION_HEADER = "X-Client-Version"
        const val ANDROID_CLIENT_NAME = "b4m-android"

        fun android(versionName: String): ClientIdentity =
            ClientIdentity(ANDROID_CLIENT_NAME, semanticVersion(versionName))

        /**
         * One to three dot-separated integers ("1", "1.2", "1.2.3"), padded with zeros to strict SemVer.
         * Anything else (a "-debug" suffix, leading zeros, signs) is not a version the server can compare.
         */
        fun semanticVersion(versionName: String): String? {
            val parts = versionName.trim().split(".")
            if (parts.size !in 1..3) return null
            val numbers = parts.map { part ->
                val valid = part.isNotEmpty() && part.all { it in '0'..'9' } && (part == "0" || !part.startsWith("0"))
                if (!valid) return null
                part.toIntOrNull() ?: return null
            }
            return (numbers + List(3 - numbers.size) { 0 }).joinToString(".")
        }
    }
}
