package com.bike4mind.kit.account

import com.bike4mind.client.B4MClientJson
import java.time.Instant
import java.time.format.DateTimeParseException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/** The server's "this account is waiting to be deleted" answer. [scheduledFor] is when it is purged, if given. */
data class AccountDeletionNotice(val scheduledFor: Instant?)

/**
 * Recognizes the 403 body a pending-deletion account gets from most routes:
 * `{"code": "ACCOUNT_DELETION_PENDING", "scheduledFor": "<ISO date>"}` (server:
 * packages/server-utils/src/auth/deletionPendingGate.ts). Twin of apps/ios AccountDeletionPendingDetector.
 */
object AccountDeletionPendingDetector {
    const val STATUS = 403
    const val CODE = "ACCOUNT_DELETION_PENDING"

    @Serializable
    private data class Body(val code: String? = null, val scheduledFor: String? = null)

    fun notice(status: Int, body: String): AccountDeletionNotice? {
        if (status != STATUS || body.isBlank()) return null
        val decoded = runCatching { B4MClientJson.decodeFromString(Body.serializer(), body) }.getOrNull()
        if (decoded?.code != CODE) return null
        return AccountDeletionNotice(decoded.scheduledFor?.let(::parseInstant))
    }
}

/**
 * Pending-deletion answers seen anywhere on the wire. The transport reports into it, so every call is covered
 * without per-call plumbing; the app swaps everything for the restore screen while [notice] is non-null.
 * Twin of apps/ios AccountStatus.
 */
class AccountDeletionSignal {
    private val state = MutableStateFlow<AccountDeletionNotice?>(null)
    val notice: StateFlow<AccountDeletionNotice?> = state.asStateFlow()

    // Set while the app signs out after its own deletion request: the revoked session's last calls answer 403
    // pending and must not flash the restore screen on the way out.
    @Volatile
    private var ignoring = false

    fun report(notice: AccountDeletionNotice) {
        if (!ignoring) state.value = notice
    }

    fun beginSignOutAfterDeletion() {
        ignoring = true
    }

    /** A restored account or a new session: nothing is pending any more. */
    fun reset() {
        ignoring = false
        state.value = null
    }
}

/** ISO 8601 with or without fractional seconds; null for anything else. */
internal fun parseInstant(value: String): Instant? = try {
    Instant.parse(value)
} catch (malformed: DateTimeParseException) {
    null
}
