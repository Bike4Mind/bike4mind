package com.bike4mind.kit.sessions

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
) {
    val failed: Boolean get() = status == QuestStatus.STOPPED || type == "error"

    companion object {
        /** The joined non-empty `replies`, else a non-empty `reply`; null when neither has text. Twin of iOS replyText. */
        fun replyText(reply: String?, replies: List<String>?): String? =
            replies.orEmpty().filter { it.isNotEmpty() }.joinToString("").ifEmpty { null }
                ?: reply?.takeIf { it.isNotEmpty() }
    }
}
