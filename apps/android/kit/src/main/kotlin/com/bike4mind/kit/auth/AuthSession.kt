package com.bike4mind.kit.auth

import com.bike4mind.kit.networking.BearerTokens
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** A signed-out session the server has not confirmed revoked yet, kept only to finish that revocation. */
data class PendingRevocation(val baseUrl: String, val refreshToken: String, val createdAtMillis: Long) {
    companion object {
        /** The server's refresh-session lifetime (`DEFAULT_REFRESH_TTL_MS` in b4m-core/services authSessionService). */
        const val MAX_AGE_MILLIS = 30L * 24 * 60 * 60 * 1000
        const val MAX_COUNT = 10

        /** Drops entries past the refresh lifetime and keeps only the newest [MAX_COUNT]. */
        fun bounded(revocations: List<PendingRevocation>, nowMillis: Long): List<PendingRevocation> =
            revocations.filter { nowMillis - it.createdAtMillis < MAX_AGE_MILLIS }.takeLast(MAX_COUNT)
    }
}

/** Persists the token pair. The app's implementation encrypts it with an Android Keystore key. */
interface TokenStore {
    suspend fun load(): Tokens?
    suspend fun save(tokens: Tokens)
    suspend fun clear()
    suspend fun loadPendingRevocations(): List<PendingRevocation>
    /** An empty list deletes the stored item. */
    suspend fun savePendingRevocations(revocations: List<PendingRevocation>)
}

/**
 * The signed-in state and the one place tokens change. Concurrent 401s share a single refresh: callers that
 * arrive while one runs wait for it and reuse its result instead of spending the refresh token twice.
 */
class AuthSession(
    private val api: AuthApi,
    private val store: TokenStore,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) : BearerTokens {
    private val tokens = MutableStateFlow<Tokens?>(null)
    private val refreshLock = Mutex()
    private val revocationLock = Mutex()
    private val retrying = AtomicBoolean(false)
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

    /**
     * Ends the session locally whatever the server answers. A revocation that fails (offline, server error) is
     * kept and finished by [retryPendingRevocations], so the server ends the session, and the push tokens bound to
     * it, once it is reachable again.
     */
    suspend fun signOut() {
        val current = tokens.value
        if (current != null && !tryLogout(current.accessToken)) {
            revocationLock.withLock {
                store.savePendingRevocations(
                    PendingRevocation.bounded(
                        store.loadPendingRevocations() +
                            PendingRevocation(api.baseUrl, current.refreshToken, nowMillis()),
                        nowMillis(),
                    ),
                )
            }
        }
        signOutLocally()
    }

    /** Finishes revocations an earlier sign-out on this server could not complete. Call at launch and on foreground. */
    suspend fun retryPendingRevocations() {
        if (!retrying.compareAndSet(false, true)) return
        try {
            val mine = revocationLock.withLock { store.loadPendingRevocations() }.filter { it.baseUrl == api.baseUrl }
            if (mine.isEmpty()) return
            // The network calls run outside the lock so a sign-out never waits on a slow retry.
            val stillPending = PendingRevocation.bounded(mine, nowMillis()).mapNotNull { revoke(it) }
            revocationLock.withLock {
                store.savePendingRevocations(
                    PendingRevocation.bounded(
                        store.loadPendingRevocations().filterNot { it in mine } + stillPending,
                        nowMillis(),
                    ),
                )
            }
        } finally {
            retrying.set(false)
        }
    }

    /** Null once the server no longer holds the session; otherwise what to retry with next time. */
    private suspend fun revoke(pending: PendingRevocation): PendingRevocation? {
        var current = pending
        return try {
            val refreshed = api.refresh(pending.refreshToken)
            current = pending.copy(refreshToken = refreshed.refreshToken)
            api.logout(refreshed.accessToken)
            null
        } catch (ended: AuthException.Rejected) {
            null
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failed: Exception) {
            current
        }
    }

    private suspend fun tryLogout(accessToken: String): Boolean = try {
        api.logout(accessToken)
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failed: Exception) {
        false
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
