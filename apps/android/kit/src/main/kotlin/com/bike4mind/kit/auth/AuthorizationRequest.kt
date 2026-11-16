package com.bike4mind.kit.auth

import com.bike4mind.kit.environment.ServerEnvironment
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** What the browser hands back on the redirect. */
sealed interface AuthorizationResult {
    data class Code(val code: String) : AuthorizationResult
    data object Denied : AuthorizationResult
    data class Failed(val reason: String) : AuthorizationResult
}

/**
 * One sign-in attempt: the authorize URL to open in a Custom Tab, and the secrets needed to finish it.
 * The web page behind /oauth/authorize handles every login method (password, Google, SSO, MFA), so Google
 * sign-in needs no native SDK. Twin of apps/ios Auth/AuthorizationRequest.swift.
 */
class AuthorizationRequest(
    environment: ServerEnvironment,
    val configuration: OAuthConfiguration,
    val verifier: String = Pkce.verifier(),
    val state: String = Pkce.state(),
) {
    val url: String = environment.baseUrl + "/oauth/authorize?" + listOf(
        "response_type" to "code",
        "client_id" to configuration.clientId,
        "redirect_uri" to configuration.redirectUri,
        "scope" to configuration.scope,
        "state" to state,
        "code_challenge" to Pkce.challenge(verifier),
        "code_challenge_method" to "S256",
    ).joinToString("&") { (key, value) -> "$key=${encode(value)}" }

    /** Null when [callbackUri] is not this request's redirect (another link, or a stale attempt's state). */
    fun result(callbackUri: String): AuthorizationResult? {
        val callback = runCatching { URI(callbackUri) }.getOrNull() ?: return null
        val expected = URI(configuration.redirectUri)
        val sameTarget = callback.scheme.equals(expected.scheme, ignoreCase = true) &&
            callback.host.equals(expected.host, ignoreCase = true) &&
            callback.path.orEmpty().trimEnd('/') == expected.path.orEmpty().trimEnd('/')
        if (!sameTarget) return null
        val query = parseQuery(callback.rawQuery)
        if (query["state"] != state) return null
        query["error"]?.let { error ->
            return if (error == "access_denied") AuthorizationResult.Denied else AuthorizationResult.Failed(error)
        }
        return query["code"]?.takeIf { it.isNotEmpty() }?.let(AuthorizationResult::Code)
            ?: AuthorizationResult.Failed("missing_code")
    }

    private companion object {
        fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8).replace("+", "%20")

        fun parseQuery(rawQuery: String?): Map<String, String> =
            rawQuery.orEmpty().split("&").filter { it.isNotEmpty() }.associate { pair ->
                val (key, value) = pair.split("=", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
                URLDecoder.decode(key, Charsets.UTF_8) to URLDecoder.decode(value, Charsets.UTF_8)
            }
    }
}
