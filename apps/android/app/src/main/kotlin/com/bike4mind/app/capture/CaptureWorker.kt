package com.bike4mind.app.capture

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.bike4mind.app.B4MApplication
import com.bike4mind.kit.capture.CaptureEngine
import kotlinx.coroutines.flow.first

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

        /**
         * Starts a run now. A run in progress picks up jobs queued meanwhile, so it is followed rather than
         * cancelled mid-send; anything else (a run waiting out its backoff) is replaced, so a new share or a
         * Retry does not wait behind that backoff.
         */
        suspend fun schedule(context: Context) {
            val workManager = WorkManager.getInstance(context)
            val running = workManager.getWorkInfosForUniqueWorkFlow(NAME).first().any { it.state == WorkInfo.State.RUNNING }
            val request = OneTimeWorkRequestBuilder<CaptureWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            val policy = if (running) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.REPLACE
            workManager.enqueueUniqueWork(NAME, policy, request)
        }
    }
}
