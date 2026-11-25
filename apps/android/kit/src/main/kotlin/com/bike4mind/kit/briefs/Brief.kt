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

/** What a follow-up decision proposes. A kind a newer server adds is UNKNOWN and shown as text only. */
enum class FollowUpKind {
    ACTION_ITEM, FOLLOW_UP_EMAIL, REMINDER, UNKNOWN;

    companion object {
        fun from(raw: String?): FollowUpKind = when (raw) {
            "actionItem" -> ACTION_ITEM
            "followUpEmail" -> FOLLOW_UP_EMAIL
            "reminder" -> REMINDER
            else -> UNKNOWN
        }
    }
}

/** Only PENDING can be edited, approved or dismissed. A state a newer server adds is UNKNOWN, treated as settled. */
enum class FollowUpState {
    PENDING, APPROVED, DISMISSED, UNKNOWN;

    companion object {
        fun from(raw: String?): FollowUpState = when (raw) {
            "pending" -> PENDING
            "approved" -> APPROVED
            "dismissed" -> DISMISSED
            else -> UNKNOWN
        }
    }
}

/**
 * A proposal from a dictated follow-up memo. Nothing happens until the user approves it, and approving an email only
 * hands the draft to the device mail app: the server never sends it. [remindAt] is when a REMINDER is due.
 */
data class BriefFollowUp(val kind: FollowUpKind, val state: FollowUpState, val remindAt: Instant? = null) {
    val isActionable: Boolean
        get() = state == FollowUpState.PENDING && kind != FollowUpKind.UNKNOWN
}

/** A drafted email. On a follow-up email [to] is the recipient the user dictated, possibly a name until edited. */
data class BriefDraftReply(val to: String, val subject: String, val body: String)

/** The fields of a pending follow-up to replace. [draftReply] applies to an email, [remindAt] to a reminder. */
data class BriefDecisionEdit(val text: String? = null, val draftReply: BriefDraftReply? = null, val remindAt: Instant? = null) {
    val isEmpty: Boolean
        get() = text == null && draftReply == null && remindAt == null
}

/**
 * The fields an edit form changed against [decision]. The form sends trimmed values, so the server draft is compared
 * trimmed too, or an untouched email reads as edited. Twin of B4MKit `BriefDecisionEdit(changing:)`.
 */
fun followUpEdit(decision: BriefDecision, kind: FollowUpKind?, text: String, draft: BriefDraftReply, remindAt: Instant, initialRemindAt: Instant): BriefDecisionEdit {
    val sent = draft.trimmed()
    // An email without a draft yet compares as blank fields, so untouched ones do not block a text-only save.
    val current = (decision.draftReply ?: BriefDraftReply("", "", "")).trimmed()
    return BriefDecisionEdit(
        text = text.trim().takeIf { it != decision.text },
        draftReply = sent.takeIf { kind == FollowUpKind.FOLLOW_UP_EMAIL && it != current },
        remindAt = remindAt.takeIf { kind == FollowUpKind.REMINDER && it != initialRemindAt },
    )
}

private fun BriefDraftReply.trimmed() = BriefDraftReply(to.trim(), subject.trim(), body.trim())

/**
 * A `mailto:` URI that opens the device mail app with this draft. `? & = #` are percent-encoded in every field, so a
 * recipient cannot add headers such as `bcc`. Encodes like android.net.Uri.encode, which the kit cannot call.
 */
fun BriefDraftReply.mailtoUri(): String =
    "mailto:" + percentEncode(to.trim(), keep = "@") + "?subject=" + percentEncode(subject) + "&body=" + percentEncode(body)

private fun percentEncode(value: String, keep: String = ""): String = buildString {
    for (byte in value.toByteArray(Charsets.UTF_8)) {
        val code = byte.toInt() and 0xff
        val char = code.toChar()
        if (code < 0x80 && (char.isLetterOrDigit() || char in "-_.!~*'()" || char in keep)) append(char) else append("%%%02X".format(code))
    }
}

enum class BriefDecisionOutcome(val wire: String) { APPROVE("approve"), DISMISS("dismiss") }

data class BriefDecision(
    val id: String,
    val text: String,
    val approval: BriefApprovalRef? = null,
    val followUp: BriefFollowUp? = null,
    val draftReply: BriefDraftReply? = null,
)

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
    /** This brief with the decision of the same id swapped for [decision]. */
    fun replacing(decision: BriefDecision): Brief =
        copy(decisions = decisions.map { if (it.id == decision.id) decision else it })

    /** Nothing worth showing: no headline and no items. */
    val isEmpty: Boolean
        get() = headline.isNullOrEmpty() && happened.isEmpty() && handled.isEmpty() && decisions.isEmpty()
}
