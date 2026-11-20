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
 * shows as a Live Update; older versions get a plain ongoing notification with an indeterminate bar. A run that
 * needs the user swaps it for a regular, alerting one; a finished run clears it.
 */
internal class AgentRunNotifications(private val context: Context) : AgentRunTracker {
    private val lastPhase = mutableMapOf<String, AgentRunPhase>()

    @SuppressLint("MissingPermission") // Guarded by areNotificationsEnabled(), which covers POST_NOTIFICATIONS.
    override fun runChanged(run: AgentRunWatch, progress: AgentRunProgress) {
        val manager = NotificationManagerCompat.from(context)
        val tag = TAG_PREFIX + run.trackingId
        val previous = synchronized(lastPhase) {
            if (progress.phase.isTerminal) lastPhase.remove(tag) else lastPhase.put(tag, progress.phase)
        }
        if (progress.phase.isTerminal) return manager.cancel(tag, ID)
        if (!manager.areNotificationsEnabled()) return
        if (progress.phase.needsUser) {
            // onlyAlertOnce would silence an update to the ongoing entry, so it is replaced to make the ask heard.
            if (previous?.needsUser != true) manager.cancel(tag, ID)
            manager.notify(tag, ID, needsUser(run, progress))
        } else {
            manager.notify(tag, ID, ongoing(run, progress))
        }
    }

    private fun ongoing(run: AgentRunWatch, progress: AgentRunProgress) =
        NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setContentTitle(run.title)
            .setContentText(progress.stageLabel ?: context.getString(R.string.agent_run_working))
            .setSubText(progress.iterations?.let { context.getString(R.string.agent_run_iteration, it) })
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setRequestPromotedOngoing(true)
            .setShortCriticalText(context.getString(R.string.agent_run_chip))
            // Polling re-posts it every few seconds; if the process dies the entry lapses instead of lying forever.
            .setTimeoutAfter(STALE_AFTER_MS)
            .setContentIntent(openChat(run))
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
                    // The server reports no step total, so how far along is the stage text and step count.
                    setStyle(NotificationCompat.ProgressStyle().setProgressIndeterminate(true))
                } else {
                    setProgress(0, 0, true)
                }
            }
            .build()

    private fun needsUser(run: AgentRunWatch, progress: AgentRunProgress) =
        NotificationCompat.Builder(context, PushNotifications.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setContentTitle(run.title)
            .setContentText(progress.stageLabel ?: context.getString(R.string.agent_run_needs_you))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOnlyAlertOnce(true)
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
            (TAG_PREFIX + run.trackingId).hashCode(),
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    companion object {
        const val CHANNEL_ID = "b4m_agent_runs"
        private const val TAG_PREFIX = "agent-run:"
        private const val ID = 1
        private const val STALE_AFTER_MS = 60_000L

        /** Low importance: an update every few seconds must not buzz. Not MIN, which would block promotion. */
        fun createChannel(context: Context) {
            val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel_agent_runs), NotificationManager.IMPORTANCE_LOW)
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}
