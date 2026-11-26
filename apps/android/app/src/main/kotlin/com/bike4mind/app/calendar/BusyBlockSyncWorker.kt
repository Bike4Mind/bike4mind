package com.bike4mind.app.calendar

import android.content.Context
import android.provider.CalendarContract
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.bike4mind.app.AppGraph
import com.bike4mind.app.B4MApplication
import java.time.Duration

/**
 * Re-syncs busy blocks when the device calendar changes. A content-URI trigger is a JobScheduler job, so it is
 * best-effort: Doze and standby buckets defer it and some OEM battery managers drop it. The foreground sync in
 * [syncInForeground] is the guaranteed path; the server's 24h freshness bound covers a trigger that never fires.
 */
class BusyBlockSyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as B4MApplication
        val graph = app.graph.value ?: return Result.retry()
        graph.session.restore()
        return settle(
            signedIn = graph.session.accessToken() != null,
            sync = { graph.busyBlockSyncer.sync(force = true) },
            rearm = { arm(applicationContext, fromWorker = true) },
        )
    }

    companion object {
        internal const val NAME = "busy-block-sync"

        /** A content-URI trigger fires once, so each run re-arms unless the server says the feature is off. */
        internal suspend fun settle(signedIn: Boolean, sync: suspend () -> Boolean?, rearm: () -> Unit): ListenableWorker.Result {
            if (!signedIn) return ListenableWorker.Result.success()
            // null is a skipped or failed sync; keep listening so the next change retries.
            if (sync() != false) rearm()
            return ListenableWorker.Result.success()
        }

        internal fun request(): OneTimeWorkRequest = OneTimeWorkRequestBuilder<BusyBlockSyncWorker>()
            .setConstraints(
                Constraints.Builder()
                    .addContentUriTrigger(CalendarContract.CONTENT_URI, true)
                    .setTriggerContentUpdateDelay(Duration.ofSeconds(10))
                    .setTriggerContentMaxDelay(Duration.ofMinutes(2))
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .build()

        /**
         * From inside a run, APPEND_OR_REPLACE chains the next trigger after the running one instead of cancelling
         * it. Anywhere else KEEP leaves an armed trigger alone, so repeated foregrounds never grow the chain.
         */
        internal fun arm(context: Context, fromWorker: Boolean = false) {
            val policy = if (fromWorker) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP
            WorkManager.getInstance(context).enqueueUniqueWork(NAME, policy, request())
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }

        /** Drops the armed trigger and the throttle, so the next account neither inherits a sync nor skips its first. */
        fun endSession(context: Context, resetThrottle: () -> Unit) {
            cancel(context)
            resetThrottle()
        }

        /** Arms the trigger while the server has the feature on and drops it once it is off; null changes nothing. */
        fun follow(context: Context, enabled: Boolean?) {
            when (enabled) {
                true -> arm(context)
                false -> cancel(context)
                null -> Unit
            }
        }

        /** Throttled by the syncer, so every resume can call it. Does nothing while signed out. */
        suspend fun syncInForeground(context: Context, graph: AppGraph) {
            if (graph.session.accessToken() == null) return
            graph.busyBlockSyncer.sync { enabled -> follow(context, enabled) }
        }
    }
}
