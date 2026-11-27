package com.bike4mind.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.bike4mind.app.R
import com.bike4mind.kit.briefs.BriefDecision
import com.bike4mind.kit.briefs.BriefDecisionEdit
import com.bike4mind.kit.briefs.BriefDraftReply
import com.bike4mind.kit.briefs.FollowUpKind
import com.bike4mind.kit.briefs.followUpEdit
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * Edits a pending follow-up before it is approved: its text, an email's draft, or a reminder's time. Only changed
 * fields are sent, and a failed save keeps the dialog open with the user's changes. Twin of apps/ios
 * Features/Brief/FollowUpEditSheet.swift.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FollowUpEditDialog(decision: BriefDecision, saving: Boolean, error: String?, onSave: (BriefDecisionEdit) -> Unit, onDismiss: () -> Unit) {
    val kind = decision.followUp?.kind
    val zone = ZoneId.systemDefault()
    var text by remember { mutableStateOf(decision.text) }
    var to by remember { mutableStateOf(decision.draftReply?.to.orEmpty()) }
    var subject by remember { mutableStateOf(decision.draftReply?.subject.orEmpty()) }
    var body by remember { mutableStateOf(decision.draftReply?.body.orEmpty()) }
    // A reminder with no time starts the pickers an hour out, but that default is only sent once the user picks.
    val initialRemindAt = remember {
        decision.followUp?.remindAt?.atZone(zone) ?: ZonedDateTime.now(zone).plusHours(1).withSecond(0).withNano(0)
    }
    var remindAt by remember { mutableStateOf(initialRemindAt) }
    var pickingDate by remember { mutableStateOf(false) }
    var pickingTime by remember { mutableStateOf(false) }

    val edit = followUpEdit(decision, kind, text, BriefDraftReply(to, subject, body), remindAt.toInstant(), initialRemindAt.toInstant())
    val complete = edit.text?.isNotEmpty() != false &&
        edit.draftReply?.let { it.to.isNotEmpty() && it.subject.isNotEmpty() && it.body.isNotEmpty() } != false

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.brief_followup_edit_title)) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                OutlinedTextField(text, { text = it }, label = { Text(stringResource(R.string.brief_followup_text)) }, modifier = Modifier.fillMaxWidth().testTag("followup-edit-text"))
                if (kind == FollowUpKind.FOLLOW_UP_EMAIL) {
                    OutlinedTextField(to, { to = it }, label = { Text(stringResource(R.string.brief_followup_email_to)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("followup-edit-to"))
                    OutlinedTextField(subject, { subject = it }, label = { Text(stringResource(R.string.brief_followup_email_subject)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("followup-edit-subject"))
                    OutlinedTextField(body, { body = it }, label = { Text(stringResource(R.string.brief_followup_email_body)) }, minLines = 3, modifier = Modifier.fillMaxWidth().testTag("followup-edit-body"))
                }
                if (kind == FollowUpKind.REMINDER) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                        OutlinedButton(onClick = { pickingDate = true }, modifier = Modifier.testTag("followup-edit-date-btn")) {
                            Text(remindAt.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)))
                        }
                        OutlinedButton(onClick = { pickingTime = true }, modifier = Modifier.testTag("followup-edit-time-btn")) {
                            Text(remindAt.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)))
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("followup-edit-error")) }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(edit) }, enabled = !saving && !edit.isEmpty && complete, modifier = Modifier.testTag("followup-edit-save-btn")) {
                Text(stringResource(R.string.brief_followup_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("followup-edit-cancel-btn")) { Text(stringResource(R.string.brief_followup_cancel)) }
        },
    )

    if (pickingDate) {
        // The date picker works in UTC midnights; only the calendar date is taken from it.
        val dateState = rememberDatePickerState(initialSelectedDateMillis = remindAt.toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { pickingDate = false },
            confirmButton = {
                TextButton(onClick = {
                    dateState.selectedDateMillis?.let {
                        val date = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()
                        remindAt = ZonedDateTime.of(date, remindAt.toLocalTime(), zone)
                    }
                    pickingDate = false
                }) { Text(stringResource(R.string.brief_followup_ok)) }
            },
        ) { DatePicker(state = dateState) }
    }
    if (pickingTime) {
        val timeState = rememberTimePickerState(initialHour = remindAt.hour, initialMinute = remindAt.minute)
        AlertDialog(
            onDismissRequest = { pickingTime = false },
            title = { Text(stringResource(R.string.brief_followup_pick_time)) },
            text = { TimePicker(state = timeState) },
            confirmButton = {
                TextButton(onClick = {
                    remindAt = ZonedDateTime.of(remindAt.toLocalDate(), LocalTime.of(timeState.hour, timeState.minute), zone)
                    pickingTime = false
                }) { Text(stringResource(R.string.brief_followup_ok)) }
            },
        )
    }
}
