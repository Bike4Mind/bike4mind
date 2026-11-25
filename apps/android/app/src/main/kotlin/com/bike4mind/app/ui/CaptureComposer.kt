package com.bike4mind.app.ui

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.content.ContextCompat
import com.bike4mind.app.R
import com.bike4mind.app.capture.CaptureFiles
import com.bike4mind.app.capture.PickedFile
import com.bike4mind.app.capture.ScanText
import com.bike4mind.kit.capture.CaptureFailure
import com.bike4mind.kit.capture.ComposerAttachment
import com.bike4mind.kit.capture.DictationState
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import java.io.File
import kotlinx.coroutines.launch

/**
 * The composer's Attach button and its menu: take a photo, scan a document, choose a file, or dictate. Every
 * file arrives in [onPicked] as a local copy; [onDictate] starts recording once the microphone is allowed. With
 * [onScanned], a scan goes there instead, with the text read from its pages on device ("" when none).
 */
@Composable
fun AttachMenu(
    onPicked: (PickedFile) -> Unit,
    onDictate: () -> Unit,
    onProblem: (String) -> Unit,
    enabled: Boolean,
    onScanned: ((PickedFile, String) -> Unit)? = null,
) {
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    var expanded by remember { mutableStateOf(false) }
    // Survives the camera app taking the foreground (and this activity being recreated behind it).
    var photoPath by rememberSaveable { mutableStateOf<String?>(null) }
    val noCamera = stringResource(R.string.capture_no_camera)
    val noScanner = stringResource(R.string.capture_scanner_unavailable)
    val readFailed = stringResource(R.string.capture_read_failed)
    val permissionDenied = stringResource(R.string.dictation_failed_permission)

    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val file = photoPath?.let(::File)
        photoPath = null
        if (file == null) return@rememberLauncherForActivityResult
        if (saved && file.length() > 0) {
            onPicked(PickedFile(file, resources.getString(R.string.capture_photo_name, CaptureFiles.stamp()), "image/jpeg"))
        } else {
            file.delete()
        }
    }
    val scan = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val scanned = GmsDocumentScanningResult.fromActivityResultIntent(result.data) ?: return@rememberLauncherForActivityResult
        val pdf = scanned.pdf?.uri ?: return@rememberLauncherForActivityResult
        val pages = scanned.pages.orEmpty().map { it.imageUri }
        scope.launch {
            val name = resources.getString(R.string.capture_scan_name, CaptureFiles.stamp())
            val picked = CaptureFiles.copy(context, pdf, name, "application/pdf") ?: return@launch onProblem(readFailed)
            if (onScanned == null) onPicked(picked) else onScanned(picked, ScanText.read(context, pages))
        }
    }
    val choose = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch { CaptureFiles.copy(context, uri)?.let(onPicked) ?: onProblem(readFailed) }
    }
    val microphone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) onDictate() else onProblem(permissionDenied)
    }

    Box {
        TextButton(onClick = { expanded = true }, enabled = enabled, modifier = Modifier.testTag("composer-attach-btn")) {
            Text(stringResource(R.string.capture_attach))
        }
        // The menu is its own window, so the activity's testTagsAsResourceId does not reach it.
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.semantics { testTagsAsResourceId = true },
        ) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.capture_take_photo)) },
                modifier = Modifier.testTag("composer-photo-btn"),
                onClick = {
                    expanded = false
                    val (file, uri) = CaptureFiles.newPhoto(context)
                    photoPath = file.absolutePath
                    try {
                        takePhoto.launch(uri)
                    } catch (missing: ActivityNotFoundException) {
                        photoPath = null
                        file.delete()
                        onProblem(noCamera)
                    }
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.capture_scan_document)) },
                modifier = Modifier.testTag("composer-scan-btn"),
                onClick = {
                    expanded = false
                    val activity = context.findActivity() ?: return@DropdownMenuItem onProblem(noScanner)
                    val options = GmsDocumentScannerOptions.Builder()
                        .setGalleryImportAllowed(true)
                        .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF, GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
                        .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
                        .build()
                    GmsDocumentScanning.getClient(options).getStartScanIntent(activity)
                        .addOnSuccessListener { sender -> scan.launch(IntentSenderRequest.Builder(sender).build()) }
                        .addOnFailureListener { onProblem(noScanner) }
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.capture_choose_file)) },
                modifier = Modifier.testTag("composer-file-btn"),
                onClick = {
                    expanded = false
                    choose.launch("*/*")
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.capture_dictate)) },
                modifier = Modifier.testTag("composer-dictate-btn"),
                onClick = {
                    expanded = false
                    val allowed = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                    if (allowed) onDictate() else microphone.launch(Manifest.permission.RECORD_AUDIO)
                },
            )
        }
    }
}

/** One row per waiting file: its name, where its upload stands, and remove (or retry when it failed). */
@Composable
fun AttachmentList(attachments: List<ComposerAttachment>, onRemove: (String) -> Unit, onRetry: (String) -> Unit) {
    if (attachments.isEmpty()) return
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        attachments.forEach { attachment ->
            Card(modifier = Modifier.fillMaxWidth().testTag("composer-attachment")) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(attachment.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                        when (val phase = attachment.phase) {
                            ComposerAttachment.Phase.Uploading -> {
                                Text(stringResource(R.string.capture_uploading), style = MaterialTheme.typography.labelSmall)
                                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                            }
                            is ComposerAttachment.Phase.Ready ->
                                Text(stringResource(R.string.capture_ready), style = MaterialTheme.typography.labelSmall)
                            is ComposerAttachment.Phase.Failed -> Text(
                                captureFailureText(phase.failure),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                    if (attachment.phase is ComposerAttachment.Phase.Failed) {
                        TextButton(onClick = { onRetry(attachment.id) }) { Text(stringResource(R.string.capture_retry)) }
                    }
                    TextButton(onClick = { onRemove(attachment.id) }, modifier = Modifier.testTag("composer-attachment-remove")) {
                        Text(stringResource(R.string.capture_remove))
                    }
                }
            }
        }
    }
}

/** Recording, then transcribing, then any problem; nothing while idle. */
@Composable
fun DictationDialog(state: DictationState, onDone: () -> Unit, onCancel: () -> Unit, onDismissFailure: () -> Unit) {
    when (state) {
        DictationState.Idle -> Unit
        DictationState.Recording, DictationState.Transcribing -> AlertDialog(
            onDismissRequest = onCancel,
            title = { Text(stringResource(R.string.dictation_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    Text(stringResource(if (state == DictationState.Recording) R.string.dictation_listening else R.string.dictation_transcribing))
                    if (state == DictationState.Transcribing) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                if (state == DictationState.Recording) {
                    TextButton(onClick = onDone, modifier = Modifier.testTag("dictation-done-btn")) { Text(stringResource(R.string.dictation_done)) }
                }
            },
            dismissButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.dictation_cancel)) } },
        )
        is DictationState.Failed -> AlertDialog(
            onDismissRequest = onDismissFailure,
            title = { Text(stringResource(R.string.dictation_title)) },
            text = {
                Text(
                    stringResource(
                        when (state) {
                            DictationState.Failed.Microphone -> R.string.dictation_failed_microphone
                            DictationState.Failed.NothingHeard -> R.string.dictation_failed_nothing_heard
                            DictationState.Failed.Unavailable -> R.string.dictation_failed_unavailable
                            DictationState.Failed.InsufficientCredits -> R.string.dictation_failed_credits
                            DictationState.Failed.Offline -> R.string.dictation_failed_offline
                            is DictationState.Failed.Other -> R.string.dictation_failed_other
                        },
                    ),
                )
            },
            confirmButton = { TextButton(onClick = onDismissFailure) { Text(stringResource(R.string.dictation_ok)) } },
        )
    }
}

@Composable
fun captureFailureText(failure: CaptureFailure): String = when (failure) {
    CaptureFailure.Offline -> stringResource(R.string.capture_failure_offline)
    CaptureFailure.Blocked -> stringResource(R.string.capture_failure_blocked)
    CaptureFailure.StillScanning -> stringResource(R.string.capture_failure_still_scanning)
    CaptureFailure.UpgradeRequired -> stringResource(R.string.capture_failure_upgrade)
    CaptureFailure.SignedOut -> stringResource(R.string.capture_failure_signed_out)
    CaptureFailure.PayloadMissing -> stringResource(R.string.capture_failure_payload_missing)
    CaptureFailure.DestinationGone -> stringResource(R.string.capture_failure_destination_gone)
    CaptureFailure.DeliveryUnknown -> stringResource(R.string.capture_failure_delivery_unknown)
    is CaptureFailure.Rejected -> failure.message ?: stringResource(R.string.capture_failure_rejected)
    CaptureFailure.Failed -> stringResource(R.string.capture_failure_generic)
}

private fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}
