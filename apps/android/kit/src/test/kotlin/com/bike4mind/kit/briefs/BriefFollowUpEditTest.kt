package com.bike4mind.kit.briefs

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BriefFollowUpEditTest {
    private val draft = BriefDraftReply("sam@example.com", "Notes", "Here they are.")
    private val email = BriefDecision("fu-email", "Send follow-up to Sam", followUp = BriefFollowUp(FollowUpKind.FOLLOW_UP_EMAIL, FollowUpState.PENDING), draftReply = draft)
    private val at = Instant.parse("2026-12-01T09:00:00Z")

    @Test
    fun mailtoEncodesReservedCharactersSoARecipientCannotAddHeaders() {
        val uri = BriefDraftReply(" sam@example.com?bcc=eve@example.com ", "Q&A + notes", "a=b?\nthanks #1").mailtoUri()
        assertEquals("mailto:sam@example.com%3Fbcc%3Deve@example.com?subject=Q%26A%20%2B%20notes&body=a%3Db%3F%0Athanks%20%231", uri)
    }

    @Test
    fun mailtoEncodesNonAsciiAsUtf8() {
        assertEquals("mailto:?subject=caf%C3%A9&body=", BriefDraftReply("", "café", "").mailtoUri())
    }

    @Test
    fun untouchedPaddedFormIsNotAnEdit() {
        val edit = followUpEdit(email, FollowUpKind.FOLLOW_UP_EMAIL, " Send follow-up to Sam ", BriefDraftReply(" sam@example.com", "Notes ", "Here they are."), at, at)
        assertTrue(edit.isEmpty)
    }

    @Test
    fun changedRecipientSendsTheWholeTrimmedDraft() {
        val edit = followUpEdit(email, FollowUpKind.FOLLOW_UP_EMAIL, email.text, draft.copy(to = " alex@example.com "), at, at)
        assertEquals(draft.copy(to = "alex@example.com"), edit.draftReply)
        assertNull(edit.text)
    }

    @Test
    fun emailWithoutDraftAllowsATextOnlySave() {
        val edit = followUpEdit(email.copy(draftReply = null), FollowUpKind.FOLLOW_UP_EMAIL, "Call Sam", BriefDraftReply("", "", ""), at, at)
        assertEquals(BriefDecisionEdit(text = "Call Sam"), edit)
    }

    @Test
    fun reminderTimeIsSentOnlyForAReminderThatChanged() {
        val later = at.plusSeconds(3600)
        assertEquals(later, followUpEdit(email, FollowUpKind.REMINDER, email.text, draft, later, at).remindAt)
        assertNull(followUpEdit(email, FollowUpKind.REMINDER, email.text, draft, at, at).remindAt)
        assertNull(followUpEdit(email, FollowUpKind.ACTION_ITEM, email.text, draft, later, at).remindAt)
    }
}
