package com.bike4mind.app.capture

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.bike4mind.app.B4MApplication
import com.bike4mind.kit.capture.CaptureEngine

/** Runs the share queue (kit CaptureEngine) with a connection, retrying with backoff while work is left. */
class CaptureWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as B4MApplication
        val graph = app.graph.value ?: return Result.retry()
        graph.session.restore()
        return when (graph.capture.runPending()) {
            CaptureEngine.RunResult.SETTLED -> Result.success()
            CaptureEngine.RunResult.RETRY_LATER -> Result.retry()
        }
    }

    companion object {
        private const val NAME = "capture-queue"

        /** Appends a run, so a share queued while one is running is not skipped. */
        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<CaptureWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }
    }
}
