package com.bike4mind.kit.auth

import com.bike4mind.kit.networking.BearerTokens
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Persists the token pair. The app's implementation encrypts it with an Android Keystore key. */
interface TokenStore {
    suspend fun load(): Tokens?
    suspend fun save(tokens: Tokens)
    suspend fun clear()
}

/**
 * The signed-in state and the one place tokens change. Concurrent 401s share a single refresh: callers that
 * arrive while one runs wait for it and reuse its result instead of spending the refresh token twice.
 */
class AuthSession(private val api: AuthApi, private val store: TokenStore) : BearerTokens {
    private val tokens = MutableStateFlow<Tokens?>(null)
    private val refreshLock = Mutex()
    private val signedIn = MutableStateFlow(false)

    val isSignedIn: StateFlow<Boolean> = signedIn.asStateFlow()

    suspend fun restore() {
        set(store.load())
    }

    override fun accessToken(): String? = tokens.value?.accessToken

    suspend fun complete(code: String, request: AuthorizationRequest, deviceName: String?) {
        val granted = api.exchange(code, request, deviceName)
        store.save(granted)
        set(granted)
    }

    /**
     * Called after a 401 that was sent with [rejectedAccessToken]. Returns the access token to retry with,
     * or null when the session is over (the user is signed out).
     */
    override suspend fun refreshAfterUnauthorized(rejectedAccessToken: String?): String? = refreshLock.withLock {
        val current = tokens.value ?: return null
        if (current.accessToken != rejectedAccessToken) return current.accessToken
        try {
            val refreshed = api.refresh(current.refreshToken)
            store.save(refreshed)
            set(refreshed)
            refreshed.accessToken
        } catch (rejected: AuthException.Rejected) {
            signOutLocally()
            null
        }
    }

    suspend fun signOut() {
        tokens.value?.accessToken?.let { api.logout(it) }
        signOutLocally()
    }

    private suspend fun signOutLocally() {
        store.clear()
        set(null)
    }

    private fun set(value: Tokens?) {
        tokens.value = value
        signedIn.value = value != null
    }
}
