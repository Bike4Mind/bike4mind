package com.bike4mind.kit.sessions

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/** One row of the chat home list. Screens never see generated types. */
data class SessionSummary(val id: String, val title: String, val lastUsedModel: String?, val lastUpdated: String)

data class SessionPage(val sessions: List<SessionSummary>, val nextCursor: String?)

enum class QuestStatus {
    PENDING, RUNNING, DONE, STOPPED, UNKNOWN;

    val isTerminal: Boolean get() = this == DONE || this == STOPPED

    companion object {
        /** Open on purpose: a status the server adds later is UNKNOWN, never a decode failure. */
        fun from(raw: String?): QuestStatus = when (raw) {
            "pending" -> PENDING
            "running" -> RUNNING
            "done" -> DONE
            "stopped" -> STOPPED
            else -> UNKNOWN
        }
    }
}

/** One prompt and its reply. [reply] is cumulative while streaming: each update replaces it. */
data class Quest(
    val id: String,
    val sessionId: String?,
    val prompt: String?,
    val reply: String?,
    val status: QuestStatus,
    val type: String?,
    val errorCode: String?,
    /** The tool call the agent is parked on, waiting for the user; null once answered or settled. */
    val pendingAction: PendingAction? = null,
) {
    val failed: Boolean get() = status == QuestStatus.STOPPED || type == "error"

    companion object {
        /** The joined non-empty `replies`, else a non-empty `reply`; null when neither has text. Twin of iOS replyText. */
        fun replyText(reply: String?, replies: List<String>?): String? =
            replies.orEmpty().filter { it.isNotEmpty() }.joinToString("").ifEmpty { null }
                ?: reply?.takeIf { it.isNotEmpty() }
    }
}

/**
 * A tool call the agent is waiting on the user to approve or deny. Wire shape `{tool, params, ts, customConnector?}`
 * (IPendingAction on the server). Twin of apps/ios B4MKit PendingAction.
 */
data class PendingAction(
    val tool: String,
    /** Argument names to a display string; enough to show what is being asked, not to execute it. */
    val params: Map<String, String>,
    /** Epoch milliseconds, as on the wire; it also identifies this action to the approve and deny routes. */
    val requestedAtMs: Long,
    /** The custom connector the call goes to; null for a built-in tool or when the source does not carry it. */
    val connector: PendingActionConnector? = null,
) {
    fun hasLapsed(nowMs: Long): Boolean = nowMs - requestedAtMs > LIFETIME_MS

    companion object {
        /** The server refuses an answer after this long (ms). */
        const val LIFETIME_MS: Long = 15 * 60 * 1000

        /** A string argument shows as is, null as empty, anything else as its JSON. */
        fun display(params: Map<String, JsonElement?>): Map<String, String> = params.mapValues { (_, value) ->
            when {
                value == null || value is JsonNull -> ""
                value is JsonPrimitive && value.isString -> value.content
                else -> value.toString()
            }
        }
    }
}

/** Where a custom connector call is sent: the connection's name and the host it talks to. */
data class PendingActionConnector(val displayName: String, val urlHost: String)
