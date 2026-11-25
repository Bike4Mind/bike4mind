package com.bike4mind.kit.networking

import com.bike4mind.client.B4MClientJson
import com.bike4mind.client.models.UpgradeRequiredResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The server refused this build (HTTP 426). [minimumVersion] is the oldest version it would accept, when given. */
data class ClientUpgradeNotice(val minimumVersion: String?)

class UpgradeRequiredException(val notice: ClientUpgradeNotice) :
    Exception("This app version is no longer supported by the server")

object ClientUpgradeDetector {
    const val STATUS = 426
    private const val ERROR_CODE = "upgrade_required"

    /** Any 426 means this build is refused; the body only adds which version would be accepted. */
    fun notice(status: Int, body: String): ClientUpgradeNotice? {
        if (status != STATUS) return null
        val decoded = runCatching { B4MClientJson.decodeFromString<UpgradeRequiredResponse>(body) }.getOrNull()
        return ClientUpgradeNotice(decoded?.takeIf { it.errorCode == ERROR_CODE }?.minimumVersion)
    }
}

/**
 * Upgrade-required answers seen anywhere on the wire. The transport reports into it so every API is covered
 * without per-call plumbing; the app covers its UI while [notice] is non-null. Only an answer without a 426
 * clears it ([clear], called by the app's re-check).
 */
class ClientUpgradeSignal {
    private val state = MutableStateFlow<ClientUpgradeNotice?>(null)
    val notice: StateFlow<ClientUpgradeNotice?> = state.asStateFlow()

    fun report(notice: ClientUpgradeNotice) {
        state.value = notice
    }

    fun clear() {
        state.value = null
    }
}
