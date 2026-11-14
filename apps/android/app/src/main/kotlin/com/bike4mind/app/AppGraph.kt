package com.bike4mind.app

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import com.bike4mind.app.push.FcmClient
import com.bike4mind.app.push.SharedPreferencesPushTokenMemory
import com.bike4mind.app.storage.KeystoreTokenStore
import com.bike4mind.client.apis.AIApi
import com.bike4mind.client.apis.AccountApi
import com.bike4mind.client.apis.SessionsApi
import com.bike4mind.client.models.GetClientConfigResponse200
import com.bike4mind.kit.auth.AuthApi
import com.bike4mind.kit.auth.AuthSession
import com.bike4mind.kit.auth.AuthorizationRequest
import com.bike4mind.kit.auth.AuthorizationResult
import com.bike4mind.kit.auth.OAuthConfiguration
import com.bike4mind.kit.chat.ChatController
import com.bike4mind.kit.chat.ChatSendWire
import com.bike4mind.kit.chat.LiveChatBackend
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.B4MTransport
import com.bike4mind.kit.networking.ClientIdentity
import com.bike4mind.kit.networking.ClientUpgradeSignal
import com.bike4mind.kit.networking.UpgradeRequiredException
import com.bike4mind.kit.networking.requireBody
import com.bike4mind.kit.push.PushRegistrationCoordinator
import com.bike4mind.kit.push.PushTokenWire
import com.bike4mind.kit.realtime.RealtimeConnection
import com.bike4mind.kit.sessions.SessionsRepository
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import kotlinx.coroutines.CoroutineScope

/**
 * Every long-lived object, wired once per server. Twin of apps/ios Bike4Mind/AppModel.swift: the screens get
 * what they need from here and never build HTTP clients of their own.
 */
class AppGraph(context: Context, val environment: ServerEnvironment) {
    private val appContext = context.applicationContext
    private val identity = ClientIdentity.android(BuildConfig.VERSION_NAME)
    val upgradeSignal = ClientUpgradeSignal()

    private val engine = OkHttp.create()

    // Sign-in calls carry the identity (so the version gate covers them) but never a bearer token: a refresh
    // sent through the authenticated client would answer its own 401 with another refresh.
    private val authHttp = HttpClient(engine) { B4MTransport(identity, upgradeSignal, tokens = null).install(this) }
    private val authApi = AuthApi(environment, authHttp)
    private val tokenStore = KeystoreTokenStore(context)
    val session = AuthSession(authApi, tokenStore)

    private val transport = B4MTransport(identity, upgradeSignal, session)
    private val http = HttpClient(engine) {
        install(WebSockets)
        transport.install(this)
    }

    private val accountApi = AccountApi(environment.baseUrl, engine) { transport.install(it) }
    val sessions = SessionsRepository(
        SessionsApi(environment.baseUrl, engine) { transport.install(it) },
        AIApi(environment.baseUrl, engine) { transport.install(it) },
    )
    private val chatBackend = LiveChatBackend(sessions, ChatSendWire(environment, http), RealtimeConnection(environment, http))

    /** Registers this install's FCM token with the server while signed in and notifications are allowed. */
    val push = PushRegistrationCoordinator(
        PushTokenWire(environment, http),
        SharedPreferencesPushTokenMemory(context),
        BuildConfig.VERSION_NAME,
    ) { message, failure -> Log.w("B4MPush", message, failure) }

    val oauth = OAuthConfiguration.forEnvironment(environment)
    private val pendingSignIn = PendingSignInStore(context)

    fun chat(sessionId: String?, scope: CoroutineScope) = ChatController(sessionId, chatBackend, scope)

    /** Feature flags, limits and the model list for this user (`GET /api/v1/client-config`). */
    suspend fun clientConfig(): GetClientConfigResponse200 = accountApi.getClientConfig().requireBody()

    /**
     * Asks the server again whether this build is still refused ("Try again"). Only an answer without a 426
     * clears the refusal; any other failure is still an answer from a server that let the build through.
     */
    suspend fun recheckUpgrade() {
        try {
            accountApi.getClientConfig()
        } catch (refused: UpgradeRequiredException) {
            return
        } catch (offline: java.io.IOException) {
            return
        }
        upgradeSignal.clear()
    }

    /** Call when a session becomes active. A build without FCM config never gets a token and registers nothing. */
    suspend fun startPush() {
        push.onNotificationsAllowed(NotificationManagerCompat.from(appContext).areNotificationsEnabled())
        push.sessionDidStart()
        FcmClient.currentToken(appContext)?.let { push.onDeviceToken(it) }
    }

    fun beginSignIn(): String {
        val request = AuthorizationRequest(environment, oauth)
        pendingSignIn.save(request.verifier, request.state)
        return request.url
    }

    /** False when [callbackUri] belongs to no sign-in this app started (a stale or foreign link). */
    suspend fun completeSignIn(callbackUri: String): SignInOutcome {
        val pending = pendingSignIn.load() ?: return SignInOutcome.Ignored
        val request = AuthorizationRequest(environment, oauth, pending.first, pending.second)
        return when (val result = request.result(callbackUri)) {
            null -> SignInOutcome.Ignored
            is AuthorizationResult.Code -> {
                pendingSignIn.clear()
                session.complete(result.code, request, Build.MODEL)
                SignInOutcome.SignedIn
            }
            AuthorizationResult.Denied -> {
                pendingSignIn.clear()
                SignInOutcome.Failed("Sign-in was cancelled.")
            }
            is AuthorizationResult.Failed -> {
                pendingSignIn.clear()
                SignInOutcome.Failed("Sign-in failed (${result.reason}).")
            }
        }
    }

    suspend fun signOutLocally() {
        tokenStore.clear()
    }

    fun close() {
        authHttp.close()
        http.close()
        engine.close()
    }
}

sealed interface SignInOutcome {
    data object SignedIn : SignInOutcome
    data object Ignored : SignInOutcome
    data class Failed(val reason: String) : SignInOutcome
}
