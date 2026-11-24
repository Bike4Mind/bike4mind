package com.bike4mind.kit.capture

import java.io.File
import java.io.IOException
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class ComposerAttachmentsTest {
    private val dir: File = createTempDirectory("composer").toFile()

    @AfterTest
    fun cleanUp() {
        dir.deleteRecursively()
    }

    private class FakeApi : CaptureApi {
        var createFailure: Exception? = null
        var status: RemoteFileStatus = RemoteFileStatus.CLEAN
        var created = 0
        val polled = mutableListOf<String>()

        override suspend fun createUpload(fileName: String, mimeType: String, byteCount: Long): UploadTicket {
            createFailure?.let { throw it }
            created++
            return UploadTicket("file-$created", "https://s3.example.test/$created", null)
        }

        override suspend fun upload(ticket: UploadTicket, file: File, mimeType: String) = Unit
        override suspend fun fileStatus(fileId: String): RemoteFileStatus {
            polled += fileId
            return status
        }
        override suspend fun findSentTurn(sessionId: String, message: String): SentTurnLookup = SentTurnLookup.NotFound
    }

    private fun TestScope.attachments(api: CaptureApi) =
        ComposerAttachments(api, CoroutineScope(StandardTestDispatcher(testScheduler)), pollIntervalMs = 0, maxPolls = 3)

    private fun file(name: String) = File(dir, name).apply { writeBytes(byteArrayOf(1, 2, 3)) }

    @Test
    fun anAddedFileUploadsThenIsReadyAndItsLocalCopyGoes() = runTest {
        val attachments = attachments(FakeApi())
        val local = file("a.png")

        attachments.add(local, "a.png", "image/png")

        assertEquals(ComposerAttachment.Phase.Uploading, attachments.state.value.single().phase)
        advanceUntilIdle()
        assertEquals(ComposerAttachment.Phase.Ready("file-1"), attachments.state.value.single().phase)
        assertFalse(local.exists())
    }

    @Test
    fun aBlockedScanFails() = runTest {
        val api = FakeApi().apply { status = RemoteFileStatus.BLOCKED }
        val attachments = attachments(api)

        attachments.add(file("a.png"), "a.png", "image/png")
        advanceUntilIdle()

        assertEquals(ComposerAttachment.Phase.Failed(CaptureFailure.Blocked), attachments.state.value.single().phase)
    }

    @Test
    fun retryAfterAScanTimeoutResumesThePollInsteadOfUploadingAgain() = runTest {
        val api = FakeApi().apply { status = RemoteFileStatus.SCANNING }
        val attachments = attachments(api)
        attachments.add(file("a.png"), "a.png", "image/png")
        advanceUntilIdle()
        assertEquals(ComposerAttachment.Phase.Failed(CaptureFailure.StillScanning), attachments.state.value.single().phase)

        api.status = RemoteFileStatus.CLEAN
        attachments.retry(attachments.state.value.single().id)
        advanceUntilIdle()

        assertEquals(ComposerAttachment.Phase.Ready("file-1"), attachments.state.value.single().phase)
        assertEquals(1, api.created)
        assertTrue(api.polled.all { it == "file-1" })
    }

    @Test
    fun aScanThatNeverFinishesFailsAsStillScanning() = runTest {
        val api = FakeApi().apply { status = RemoteFileStatus.SCANNING }
        val attachments = attachments(api)

        attachments.add(file("a.png"), "a.png", "image/png")
        advanceUntilIdle()

        assertEquals(ComposerAttachment.Phase.Failed(CaptureFailure.StillScanning), attachments.state.value.single().phase)
    }

    @Test
    fun offlineFailsThenRetryRecovers() = runTest {
        val api = FakeApi().apply { createFailure = IOException("offline") }
        val attachments = attachments(api)
        val local = file("a.png")

        attachments.add(local, "a.png", "image/png")
        advanceUntilIdle()
        val id = attachments.state.value.single().id
        assertEquals(ComposerAttachment.Phase.Failed(CaptureFailure.Offline), attachments.state.value.single().phase)
        assertTrue(local.exists())

        api.createFailure = null
        attachments.retry(id)
        advanceUntilIdle()

        assertEquals(ComposerAttachment.Phase.Ready("file-1"), attachments.state.value.single().phase)
    }

    @Test
    fun retryIgnoresAnAttachmentThatDidNotFail() = runTest {
        val api = FakeApi()
        val attachments = attachments(api)
        attachments.add(file("a.png"), "a.png", "image/png")
        advanceUntilIdle()

        attachments.retry(attachments.state.value.single().id)
        advanceUntilIdle()

        assertEquals(1, api.created)
    }

    @Test
    fun readyFileIdsWaitsForEveryAttachmentAndKeepsOrder() = runTest {
        val api = FakeApi()
        val attachments = attachments(api)

        attachments.add(file("a.png"), "a.png", "image/png")
        attachments.add(file("b.png"), "b.png", "image/png")
        assertNull(attachments.state.value.readyFileIds())

        advanceUntilIdle()
        assertEquals(listOf("file-1", "file-2"), attachments.state.value.readyFileIds())

        api.createFailure = IOException("offline")
        attachments.add(file("c.png"), "c.png", "image/png")
        advanceUntilIdle()
        assertNull(attachments.state.value.readyFileIds())
    }

    @Test
    fun emptyListHasNoFileIdsToWaitFor() {
        assertEquals(emptyList(), emptyList<ComposerAttachment>().readyFileIds())
    }

    @Test
    fun removeDropsTheEntryAndDeletesTheFile() = runTest {
        val api = FakeApi().apply { createFailure = IOException("offline") }
        val attachments = attachments(api)
        val local = file("a.png")
        attachments.add(local, "a.png", "image/png")
        advanceUntilIdle()

        attachments.remove(attachments.state.value.single().id)

        assertTrue(attachments.state.value.isEmpty())
        assertFalse(local.exists())
    }

    @Test
    fun clearWithFileIdsDropsOnlyThoseSentFiles() = runTest {
        val attachments = attachments(FakeApi())
        attachments.add(file("a.png"), "a.png", "image/png")
        attachments.add(file("b.png"), "b.png", "image/png")
        advanceUntilIdle()

        attachments.clear(listOf("file-1"))

        assertEquals(ComposerAttachment.Phase.Ready("file-2"), attachments.state.value.single().phase)
    }

    @Test
    fun clearWithFileIdsKeepsAnAttachmentStillUploading() = runTest {
        val attachments = attachments(FakeApi())
        attachments.add(file("a.png"), "a.png", "image/png")
        advanceUntilIdle()
        attachments.add(file("b.png"), "b.png", "image/png")

        attachments.clear(listOf("file-1"))

        assertEquals(ComposerAttachment.Phase.Uploading, attachments.state.value.single().phase)
    }
}
