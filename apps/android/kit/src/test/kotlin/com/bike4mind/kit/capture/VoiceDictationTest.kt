package com.bike4mind.kit.capture

import java.io.File
import java.io.IOException
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceDictationTest {
    private val dir: File = createTempDirectory("dictation").toFile()

    @AfterTest
    fun cleanUp() {
        dir.deleteRecursively()
    }

    private class FakeRecorder(private val output: File?) : AudioRecorder {
        var startFailure: Exception? = null
        var cancelled = false
        override fun start() {
            startFailure?.let { throw it }
        }

        override fun stop(): File? = output
        override fun cancel() {
            cancelled = true
        }
    }

    private val recording get() = File(dir, "rec.m4a").apply { writeBytes(byteArrayOf(1)) }

    private fun TestScope.dictation(recorder: AudioRecorder, transcriber: Transcriber) =
        VoiceDictation(recorder, transcriber, CoroutineScope(StandardTestDispatcher(testScheduler)))

    @Test
    fun startRecordsAndFinishTranscribesIntoTheCallback() = runTest {
        val audio = recording
        val dictation = dictation(FakeRecorder(audio)) { file, mime ->
            assertEquals(AudioRecorder.MIME_TYPE, mime)
            assertEquals(audio, file)
            "hello"
        }
        val received = mutableListOf<String>()

        dictation.start()
        assertEquals(DictationState.Recording, dictation.state.value)
        dictation.finish { received += it }
        assertEquals(DictationState.Transcribing, dictation.state.value)
        advanceUntilIdle()

        assertEquals(DictationState.Idle, dictation.state.value)
        assertEquals(listOf("hello"), received)
        assertFalse(audio.exists())
    }

    @Test
    fun aMicrophoneThatWillNotOpenFails() = runTest {
        val recorder = FakeRecorder(null).apply { startFailure = IllegalStateException("busy") }
        val dictation = dictation(recorder) { _, _ -> "x" }

        dictation.start()

        assertEquals(DictationState.Failed.Microphone, dictation.state.value)
    }

    @Test
    fun nothingRecordedIsNothingHeard() = runTest {
        val dictation = dictation(FakeRecorder(null)) { _, _ -> error("not called") }

        dictation.start()
        dictation.finish { error("no text") }

        assertEquals(DictationState.Failed.NothingHeard, dictation.state.value)
    }

    @Test
    fun noCreditsIsReported() = runTest {
        val dictation = dictation(FakeRecorder(recording)) { _, _ -> throw TranscriptionException.InsufficientCredits() }

        dictation.start()
        dictation.finish { error("no text") }
        advanceUntilIdle()

        assertEquals(DictationState.Failed.InsufficientCredits, dictation.state.value)
    }

    @Test
    fun otherFailuresMapToTheirStates() = runTest {
        val cases = mapOf<Exception, DictationState>(
            TranscriptionException.Unavailable() to DictationState.Failed.Unavailable,
            TranscriptionException.UnusableRecording() to DictationState.Failed.NothingHeard,
            IOException("offline") to DictationState.Failed.Offline,
            TranscriptionException.Failed("boom") to DictationState.Failed.Other("boom"),
        )
        for ((error, expected) in cases) {
            val dictation = dictation(FakeRecorder(recording)) { _, _ -> throw error }
            dictation.start()
            dictation.finish { }
            advanceUntilIdle()
            assertEquals(expected, dictation.state.value, error.toString())
        }
    }

    @Test
    fun blankTextIsNothingHeard() = runTest {
        val dictation = dictation(FakeRecorder(recording)) { _, _ -> "" }

        dictation.start()
        dictation.finish { error("no text") }
        advanceUntilIdle()

        assertEquals(DictationState.Failed.NothingHeard, dictation.state.value)
    }

    @Test
    fun cancelWhileRecordingStopsTheRecorder() = runTest {
        val recorder = FakeRecorder(null)
        val dictation = dictation(recorder) { _, _ -> "x" }

        dictation.start()
        dictation.cancel()

        assertTrue(recorder.cancelled)
        assertEquals(DictationState.Idle, dictation.state.value)
    }

    @Test
    fun cancelWhileTranscribingDropsTheResult() = runTest {
        val gate = CompletableDeferred<String>()
        val dictation = dictation(FakeRecorder(recording)) { _, _ -> gate.await() }
        val received = mutableListOf<String>()

        dictation.start()
        dictation.finish { received += it }
        runCurrent()
        dictation.cancel()
        gate.complete("late")
        advanceUntilIdle()

        assertEquals(DictationState.Idle, dictation.state.value)
        assertTrue(received.isEmpty())
    }

    @Test
    fun dismissClearsAFailure() = runTest {
        val dictation = dictation(FakeRecorder(null)) { _, _ -> "x" }
        dictation.start()
        dictation.finish { }

        dictation.dismissFailure()

        assertEquals(DictationState.Idle, dictation.state.value)
    }
}
