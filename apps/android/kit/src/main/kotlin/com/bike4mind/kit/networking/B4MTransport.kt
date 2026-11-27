package com.bike4mind.kit.networking

import com.bike4mind.client.installB4MJson
import com.bike4mind.kit.account.AccountDeletionPendingDetector
import com.bike4mind.kit.account.AccountDeletionSignal
import io.ktor.client.HttpClientConfig
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.api.Send
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode

/** Where the transport gets the bearer token, and how it recovers from a 401. Implemented by AuthSession. */
interface BearerTokens {
    /** The current access token, or null when signed out. */
    fun accessToken(): String?

    /** A token to retry with after a 401 sent with [rejectedAccessToken], or null to give up. */
    suspend fun refreshAfterUnauthorized(rejectedAccessToken: String?): String?
}

/**
 * The cross-cutting wire concerns every call shares, applied as each generated API's `httpClientConfig` and to
 * the hand-written wires: JSON, the client identity headers, the bearer token with one refresh-and-retry on 401,
 * 426 detection, and the 403 a pending-deletion account gets (reported to [deletionSignal]). Twin of apps/ios
 * `URLSessionTransport` (B4MKit/Networking/HTTPTransport.swift). Pass [tokens] = null for the auth routes
 * themselves, which must not carry a bearer.
 */
class B4MTransport(
    private val identity: ClientIdentity,
    private val upgradeSignal: ClientUpgradeSignal,
    private val tokens: BearerTokens?,
    private val deletionSignal: AccountDeletionSignal? = null,
) {
    fun install(config: HttpClientConfig<*>) {
        config.installB4MJson()
        config.install(
            createClientPlugin("B4MRequest") {
                onRequest { request, _ ->
                    identity.headers.forEach { (name, value) ->
                        if (!request.headers.contains(name)) request.headers.append(name, value)
                    }
                    tokens?.accessToken()?.let { request.headers[HttpHeaders.Authorization] = "Bearer $it" }
                }
                on(Send) { request ->
                    val call = proceed(request)
                    val sentToken = request.headers[HttpHeaders.Authorization]?.removePrefix("Bearer ")
                    if (tokens == null || sentToken == null || call.response.status != HttpStatusCode.Unauthorized) {
                        return@on call
                    }
                    val retryToken = tokens.refreshAfterUnauthorized(sentToken) ?: return@on call
                    request.headers[HttpHeaders.Authorization] = "Bearer $retryToken"
                    proceed(request)
                }
            },
        )
        config.HttpResponseValidator {
            validateResponse { response ->
                val status = response.status.value
                if (deletionSignal != null && status == AccountDeletionPendingDetector.STATUS) {
                    AccountDeletionPendingDetector.notice(status, response.bodyAsText())?.let(deletionSignal::report)
                    return@validateResponse
                }
                if (status != ClientUpgradeDetector.STATUS) return@validateResponse
                val notice = ClientUpgradeDetector.notice(response.status.value, response.bodyAsText())
                if (notice != null) {
                    upgradeSignal.report(notice)
                    throw UpgradeRequiredException(notice)
                }
            }
        }
    }
}
