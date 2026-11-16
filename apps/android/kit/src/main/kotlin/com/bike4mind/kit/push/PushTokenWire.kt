package com.bike4mind.kit.push

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.Serializable

/** The two push-token calls the app makes (`/api/v1/push-tokens`). */
interface PushTokenApi {
    /** Idempotent upsert of this device's FCM token for the signed-in user and session. */
    suspend fun register(token: String, appVersion: String?)

    /** Succeeds whether or not the token was registered. */
    suspend fun unregister(token: String)
}

/**
 * Hand-written `registerPushToken` / `unregisterPushToken`: the operations are not in `client/operations.txt`
 * yet. Twin of apps/ios PushTokenClient; [http] carries the B4MTransport (bearer, one 401 refresh, identity).
 */
class PushTokenWire(private val environment: ServerEnvironment, private val http: HttpClient) : PushTokenApi {
    // No defaults on the fixed fields: B4MClientJson omits default values, and the server requires them.
    @Serializable
    private data class RegisterBody(
        val token: String,
        val kind: String,
        val platform: String,
        val environment: String,
        val appVersion: String? = null,
    )

    @Serializable
    private data class UnregisterBody(val token: String)

    override suspend fun register(token: String, appVersion: String?) {
        // FCM has no sandbox/production split; the contract still requires a value, and it is ignored for android.
        val body = RegisterBody(token, kind = "device", platform = "android", environment = "production", appVersion = appVersion)
        val response = http.post(pushTokensUrl(environment)) {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(RegisterBody.serializer(), body))
        }
        if (!response.status.isSuccess()) throw ApiException(response.status.value)
    }

    override suspend fun unregister(token: String) {
        val response = http.delete(pushTokensUrl(environment)) {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(UnregisterBody.serializer(), UnregisterBody(token)))
        }
        if (!response.status.isSuccess()) throw ApiException(response.status.value)
    }

    private companion object {
        fun pushTokensUrl(environment: ServerEnvironment) = environment.baseUrl + "/api/v1/push-tokens"
    }
}
