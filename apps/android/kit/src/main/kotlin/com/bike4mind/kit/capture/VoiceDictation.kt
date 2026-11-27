package com.bike4mind.kit.capture

import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The microphone. The app's is MediaRecorder writing AAC in an MPEG-4 container ([MIME_TYPE]). */
interface AudioRecorder {
    /** Throws when the microphone cannot be opened. */
    fun start()

    /** The finished recording, or null when nothing usable was captured. */
    fun stop(): File?

    fun cancel()

    companion object {
        const val MIME_TYPE = "audio/mp4"
    }
}

sealed interface DictationState {
    data object Idle : DictationState
    data object Recording : DictationState
    data object Transcribing : DictationState

    sealed interface Failed : DictationState {
        data object Microphone : Failed
        data object NothingHeard : Failed
        data object Unavailable : Failed
        data object InsufficientCredits : Failed
        data object Offline : Failed
        data class Other(val message: String?) : Failed
    }
}

/**
 * Dictation into a composer: record, send the audio for transcription, hand back the text. Twin of apps/ios
 * Capture/VoiceCapture.swift.
 */
class VoiceDictation(
    private val recorder: AudioRecorder,
    private val transcriber: Transcriber,
    private val scope: CoroutineScope,
    private val log: (String, Throwable) -> Unit = { _, _ -> },
) {
    private val mutableState = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = mutableState.asStateFlow()
    private var transcription: Job? = null

    fun start() {
        if (mutableState.value == DictationState.Recording || mutableState.value == DictationState.Transcribing) return
        mutableState.value = try {
            recorder.start()
            DictationState.Recording
        } catch (error: Exception) {
            DictationState.Failed.Microphone
        }
    }

    /** Stops recording and transcribes; [onText] gets the words when there are any. */
    fun finish(onText: (String) -> Unit) {
        if (mutableState.value != DictationState.Recording) return
        val audio = recorder.stop()
        if (audio == null) {
            mutableState.value = DictationState.Failed.NothingHeard
            return
        }
        mutableState.value = DictationState.Transcribing
        transcription = scope.launch {
            mutableState.value = try {
                val text = transcriber.transcribe(audio, AudioRecorder.MIME_TYPE)
                if (text.isEmpty()) {
                    DictationState.Failed.NothingHeard
                } else {
                    onText(text)
                    DictationState.Idle
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                log("Transcription failed", error)
                failure(error)
            } finally {
                audio.delete()
            }
        }
    }

    fun cancel() {
        if (mutableState.value == DictationState.Recording) recorder.cancel()
        transcription?.cancel()
        transcription = null
        mutableState.value = DictationState.Idle
    }

    fun dismissFailure() {
        if (mutableState.value is DictationState.Failed) mutableState.value = DictationState.Idle
    }

    private fun failure(error: Exception): DictationState.Failed = when (error) {
        is TranscriptionException.UnusableRecording -> DictationState.Failed.NothingHeard
        is TranscriptionException.Unavailable -> DictationState.Failed.Unavailable
        is TranscriptionException.InsufficientCredits -> DictationState.Failed.InsufficientCredits
        is TranscriptionException.Failed -> DictationState.Failed.Other(error.message)
        is java.io.IOException -> DictationState.Failed.Offline
        else -> DictationState.Failed.Other(null)
    }
}
