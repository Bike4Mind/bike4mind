package com.bike4mind.kit.auth

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import io.ktor.client.HttpClient
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

data class Tokens(val accessToken: String, val refreshToken: String)

sealed class AuthException(message: String) : Exception(message) {
    /** The server refused the grant or the refresh token; the user must sign in again. */
    class Rejected(val error: String?) : AuthException("Sign-in was rejected: ${error ?: "unknown"}")
    class RateLimited : AuthException("Too many sign-in attempts")
    class Server(val status: Int) : AuthException("Sign-in failed with HTTP $status")
}

/**
 * The hand-written auth routes (not in the OpenAPI spec). Twin of apps/ios Auth/AuthAPI.swift.
 * [http] must carry the client identity headers (B4MTransport) but no bearer token.
 */
class AuthApi(private val environment: ServerEnvironment, private val http: HttpClient) {
    @Serializable
    private data class TokenRequest(
        @SerialName("grant_type") val grantType: String,
        val code: String,
        @SerialName("code_verifier") val codeVerifier: String,
        @SerialName("client_id") val clientId: String,
        @SerialName("redirect_uri") val redirectUri: String,
        val deviceName: String?,
    )

    @Serializable
    private data class TokenResponse(
        @SerialName("access_token") val accessToken: String,
        @SerialName("refresh_token") val refreshToken: String,
    )

    @Serializable
    private data class RefreshRequest(val token: String)

    @Serializable
    private data class RefreshResponse(val accessToken: String, val refreshToken: String? = null)

    @Serializable
    private data class ErrorResponse(val error: String? = null)

    suspend fun exchange(code: String, request: AuthorizationRequest, deviceName: String?): Tokens {
        val body = TokenRequest(
            grantType = "authorization_code",
            code = code,
            codeVerifier = request.verifier,
            clientId = request.configuration.clientId,
            redirectUri = request.configuration.redirectUri,
            deviceName = deviceName,
        )
        val response = http.post(environment.baseUrl + "/api/oauth/token") {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(TokenRequest.serializer(), body))
        }
        val text = response.bodyAsText()
        return when (response.status) {
            HttpStatusCode.OK -> B4MClientJson.decodeFromString(TokenResponse.serializer(), text)
                .let { Tokens(it.accessToken, it.refreshToken) }
            HttpStatusCode.TooManyRequests -> throw AuthException.RateLimited()
            else -> if (response.status.value in 400..499) {
                throw AuthException.Rejected(runCatching { B4MClientJson.decodeFromString(ErrorResponse.serializer(), text).error }.getOrNull())
            } else {
                throw AuthException.Server(response.status.value)
            }
        }
    }

    /** A response without a new refresh token means the stored one stays valid. */
    suspend fun refresh(refreshToken: String): Tokens {
        val response = http.post(environment.baseUrl + "/api/auth/refreshToken") {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(RefreshRequest.serializer(), RefreshRequest(refreshToken)))
        }
        return when (response.status) {
            HttpStatusCode.OK -> B4MClientJson.decodeFromString(RefreshResponse.serializer(), response.bodyAsText())
                .let { Tokens(it.accessToken, it.refreshToken ?: refreshToken) }
            HttpStatusCode.Unauthorized -> throw AuthException.Rejected("refresh_rejected")
            HttpStatusCode.TooManyRequests -> throw AuthException.RateLimited()
            else -> throw AuthException.Server(response.status.value)
        }
    }

    /** Best effort: the local sign-out happens whatever the server answers. */
    suspend fun logout(accessToken: String) {
        runCatching { http.get(environment.baseUrl + "/api/logout") { bearerAuth(accessToken) } }
    }
}
