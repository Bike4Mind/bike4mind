package com.bike4mind.kit.push

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/** The last token the server accepted, kept across launches so a token the server still pushes to can be withdrawn. */
interface PushTokenMemory {
    suspend fun load(): String?
    suspend fun save(token: String?)
}

/**
 * Owns the push-registration state machine. Twin of apps/ios PushRegistrationCoordinator.
 *
 * The device is registered only while a session is active and notifications are allowed, because the server ties
 * a token to the session that registered it. A user who turns notifications off is withdrawn from the server so it
 * stops pushing to a mute device. Sign-out unregisters best effort *before* the session is torn down, since the
 * call needs the bearer token. Calls are serialized, so a token refresh racing a permission change cannot interleave.
 */
class PushRegistrationCoordinator(
    private val api: PushTokenApi,
    private val memory: PushTokenMemory,
    private val appVersion: String?,
    private val log: (String, Throwable) -> Unit = { _, _ -> },
) {
    private val lock = Mutex()
    private var sessionActive = false
    private var notificationsAllowed = false
    private var deviceToken: String? = null
    private var registeredToken: String? = null

    /** A session became active (sign-in or a restored launch): register again, since tokens are per session. */
    suspend fun sessionDidStart() = lock.withLock {
        sessionActive = true
        registeredToken = null
        sync()
    }

    /** The session ended without our involvement (revoked, expired): nothing can be sent, so only forget local state. */
    suspend fun sessionDidEnd() = lock.withLock {
        sessionActive = false
        registeredToken = null
    }

    /** FCM issued or rotated the device token. */
    suspend fun onDeviceToken(token: String) = lock.withLock {
        deviceToken = token
        sync()
    }

    /** The OS notification permission (or the user's per-app switch) changed. */
    suspend fun onNotificationsAllowed(allowed: Boolean) = lock.withLock {
        notificationsAllowed = allowed
        if (!allowed) withdraw()
        sync()
    }

    /** Call just before a user-initiated sign-out. Gives up after [timeoutMillis] so sign-out never hangs on a bad network. */
    suspend fun unregisterBeforeSignOut(timeoutMillis: Long = 3_000) {
        withTimeoutOrNull(timeoutMillis) {
            lock.withLock {
                val token = if (sessionActive) registeredToken ?: deviceToken else null
                if (token != null) unregisterQuietly(token)
            }
        }
        sessionDidEnd()
    }

    private suspend fun sync() {
        val token = deviceToken
        if (!sessionActive || !notificationsAllowed || token == null || token == registeredToken) return
        try {
            api.register(token, appVersion)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            log("Push token registration failed", failure)
            return
        }
        registeredToken = token
        val previous = memory.load()
        memory.save(token)
        // FCM rotated the token; the old one would otherwise stay registered until it bounces.
        if (previous != null && previous != token) unregisterQuietly(previous)
    }

    private suspend fun withdraw() {
        if (!sessionActive) return
        val token = registeredToken ?: memory.load() ?: return
        registeredToken = null
        unregisterQuietly(token)
    }

    private suspend fun unregisterQuietly(token: String) {
        try {
            api.unregister(token)
            if (memory.load() == token) memory.save(null)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            log("Push token unregister failed (best effort)", failure)
        }
    }
}
