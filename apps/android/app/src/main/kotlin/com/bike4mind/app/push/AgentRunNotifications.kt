package com.bike4mind.app.push

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.bike4mind.app.MainActivity
import com.bike4mind.app.R
import com.bike4mind.kit.agents.AgentRunPhase
import com.bike4mind.kit.agents.AgentRunProgress
import com.bike4mind.kit.agents.AgentRunTracker
import com.bike4mind.kit.agents.AgentRunWatch

/**
 * The ongoing notification for a running agent: Android's counterpart of the iOS Live Activity
 * (apps/ios Widgets/QuestLiveActivity.swift). On Android 16+ it uses ProgressStyle and asks to be promoted, so it
 * shows as a Live Update; older versions get a plain ongoing notification. The bar is determinate only when the server
 * reports a step total for the run, and indeterminate otherwise. A run that needs the user turns it into a regular,
 * alerting one; a finished run clears it. While a run shows here,
 * AgentRunKeepAlive keeps the app running so the polling behind it survives the user leaving the app.
 */
internal class AgentRunNotifications(private val context: Context) : AgentRunTracker {
    private val lastPhase = mutableMapOf<Int, AgentRunPhase>()

    @SuppressLint("MissingPermission") // Guarded by areNotificationsEnabled(), which covers POST_NOTIFICATIONS.
    override fun runChanged(run: AgentRunWatch, progress: AgentRunProgress) {
        if (progress.phase.isTerminal) return runEnded(run)
        val id = notificationId(run)
        val previous = synchronized(lastPhase) { lastPhase.put(id, progress.phase) }
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        val notification = if (progress.phase.needsUser) {
            val firstAsk = previous?.needsUser != true
            // An update under onlyAlertOnce is silent, so the ask is posted fresh. cancel() is a no-op while the
            // keep-alive service is foreground on this id; the ask then alerts as an update instead.
            if (firstAsk) manager.cancel(id)
            needsUser(run, progress, alert = firstAsk)
        } else {
            ongoing(run, progress)
        }
        manager.notify(id, notification)
        AgentRunKeepAlive.hold(context, id, notification)
    }

    override fun runEnded(run: AgentRunWatch) {
        val id = notificationId(run)
        synchronized(lastPhase) { lastPhase.remove(id) }
        AgentRunKeepAlive.release(id)
        NotificationManagerCompat.from(context).cancel(id)
    }

    private fun ongoing(run: AgentRunWatch, progress: AgentRunProgress) =
        NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setContentTitle(run.title)
            .setContentText(progress.stageLabel ?: context.getString(R.string.agent_run_working))
            .setSubText(subText(progress))
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setRequestPromotedOngoing(true)
            .setShortCriticalText(context.getString(R.string.agent_run_chip))
            // Each poll re-posts it; if polling stops without an end (process killed) it lapses instead of lying forever.
            .setTimeoutAfter(STALE_AFTER_MS)
            .setContentIntent(openChat(run))
            .apply {
                // Most runs have no knowable total (step_progress is null); those keep the indeterminate bar.
                val steps = progress.steps
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
                    val style = NotificationCompat.ProgressStyle()
                    if (steps == null) {
                        style.setProgressIndeterminate(true)
                    } else {
                        style.setProgressSegments(listOf(NotificationCompat.ProgressStyle.Segment(steps.total)))
                            .setProgress(steps.completed)
                    }
                    setStyle(style)
                } else if (steps == null) {
                    setProgress(0, 0, true)
                } else {
                    setProgress(steps.total, steps.completed, false)
                }
            }
            .build()

    /** "2 of 5 steps done" when the total is known, else the iteration count; never iterations against a step total. */
    private fun subText(progress: AgentRunProgress): String? {
        progress.steps?.let { return context.getString(R.string.agent_run_steps_done, it.completed, it.total) }
        return progress.iterations?.let { context.getString(R.string.agent_run_iteration, it) }
    }

    private fun needsUser(run: AgentRunWatch, progress: AgentRunProgress, alert: Boolean) =
        NotificationCompat.Builder(context, PushNotifications.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setContentTitle(run.title)
            .setContentText(progress.stageLabel ?: context.getString(R.string.agent_run_needs_you))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOnlyAlertOnce(!alert)
            .setAutoCancel(true)
            .setContentIntent(openChat(run))
            .build()

    /** Opens the run's chat the way a tapped push does: MainActivity reads `sessionId` from the extras (PushRoute). */
    private fun openChat(run: AgentRunWatch): PendingIntent {
        val launch = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("sessionId", run.sessionId)
        return PendingIntent.getActivity(
            context,
            notificationId(run),
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /** Untagged, because a foreground service's notification is addressed by id alone. Pushes post tagged, at id 0. */
    private fun notificationId(run: AgentRunWatch) = (TAG_PREFIX + run.trackingId).hashCode()

    companion object {
        const val CHANNEL_ID = "b4m_agent_runs"
        private const val TAG_PREFIX = "agent-run:"
        private const val STALE_AFTER_MS = 60_000L

        /** Low importance: an update every few seconds must not buzz. Not MIN, which would block promotion. */
        fun createChannel(context: Context) {
            val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel_agent_runs), NotificationManager.IMPORTANCE_LOW)
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}
