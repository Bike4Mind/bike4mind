package com.bike4mind.app.capture

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import com.bike4mind.kit.capture.AudioRecorder
import java.io.File
import java.util.UUID

/** AAC in an MPEG-4 container, the type the transcription route takes as `audio/mp4`. */
class MediaAudioRecorder(private val context: Context) : AudioRecorder {
    private var recorder: MediaRecorder? = null
    private var output: File? = null

    override fun start() {
        release()
        val file = File(CaptureFiles.directory(context), "voice-${UUID.randomUUID()}.m4a")
        val created = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            created.setAudioSource(MediaRecorder.AudioSource.MIC)
            created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            created.setAudioSamplingRate(44_100)
            created.setAudioEncodingBitRate(64_000)
            created.setOutputFile(file.absolutePath)
            created.prepare()
            created.start()
        } catch (error: Exception) {
            created.release()
            file.delete()
            throw error
        }
        recorder = created
        output = file
    }

    override fun stop(): File? {
        val active = recorder ?: return null
        val file = output
        recorder = null
        output = null
        return try {
            active.stop()
            file?.takeIf { it.length() > 0 }
        } catch (tooShort: RuntimeException) {
            // MediaRecorder throws on stop when no audio frame was written.
            file?.delete()
            null
        } finally {
            active.release()
        }
    }

    override fun cancel() {
        stop()?.delete()
    }

    private fun release() {
        recorder?.release()
        recorder = null
        output?.delete()
        output = null
    }
}
