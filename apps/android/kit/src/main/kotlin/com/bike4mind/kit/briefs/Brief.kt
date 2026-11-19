package com.bike4mind.kit.briefs

import java.time.Instant

/** Where a server-composed brief is in its life. Twin of apps/ios B4MKit/Briefs/Brief.swift. */
enum class BriefStatus {
    COMPOSING, READY, FAILED, UNKNOWN;

    companion object {
        /** Open on purpose: a status a newer server adds is UNKNOWN (not yet readable), never a decode failure. */
        fun from(raw: String?): BriefStatus = when (raw) {
            "composing" -> COMPOSING
            "ready" -> READY
            "failed" -> FAILED
            else -> UNKNOWN
        }
    }
}

data class BriefItem(val id: String, val text: String)

/** The pending agent approval a decision refers to. The approval card itself lives in the session transcript. */
data class BriefApprovalRef(val questId: String, val sessionId: String, val pendingActionTs: Long)

data class BriefDecision(val id: String, val text: String, val approval: BriefApprovalRef? = null)

/** A server-composed summary of what happened, what was handled and what needs the user (`/api/v1/briefs`). */
data class Brief(
    val id: String,
    val status: BriefStatus,
    val createdAt: Instant?,
    val composedAt: Instant? = null,
    val periodStart: Instant?,
    val periodEnd: Instant?,
    val headline: String? = null,
    val happened: List<BriefItem> = emptyList(),
    val handled: List<BriefItem> = emptyList(),
    val decisions: List<BriefDecision> = emptyList(),
) {
    /** Nothing worth showing: no headline and no items. */
    val isEmpty: Boolean
        get() = headline.isNullOrEmpty() && happened.isEmpty() && handled.isEmpty() && decisions.isEmpty()
}
