package com.bike4mind.app.push

import android.annotation.SuppressLint
import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the app running while it follows an agent run, so kit AgentRunMonitor keeps polling after the user leaves:
 * a backgrounded app loses network within seconds and is then frozen. The service is foreground on one of the runs'
 * own notifications (AgentRunNotifications), so it adds no notification of its own; when that run ends it moves to
 * another held run, or stops.
 */
class AgentRunKeepAlive : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        synchronized(lock) {
            instance = this
            starting = false
            // startForegroundService() obliges a startForeground() even if every run ended while this was starting.
            val first = held.entries.firstOrNull()?.toPair() ?: lastHeld
            if (first == null || !enterForeground(first.first, first.second) || held.isEmpty()) stop()
        }
        return START_NOT_STICKY
    }

    /** Android 15+ caps dataSync services per day. Polling then lasts only while the app is in front. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        synchronized(lock) { stop() }
    }

    override fun onDestroy() {
        synchronized(lock) {
            if (instance === this) {
                instance = null
                foregroundId = null
            }
        }
    }

    /** Moves the foreground onto a run still held, or stops when none is. Caller holds [lock]. */
    private fun follow() {
        val next = held.entries.firstOrNull()
        if (next == null || !enterForeground(next.key, next.value)) stop()
    }

    @SuppressLint("InlinedApi") // ServiceCompat drops the type below Android 10, where it does not exist.
    private fun enterForeground(id: Int, notification: Notification): Boolean = try {
        ServiceCompat.startForeground(this, id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        foregroundId = id
        true
    } catch (refused: RuntimeException) {
        // ForegroundServiceStartNotAllowedException (started from the background) or a missing permission.
        false
    }

    private fun stop() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foregroundId = null
        instance = null
        stopSelf()
    }

    companion object {
        private val lock = Any()
        private val held = LinkedHashMap<Int, Notification>()
        private var lastHeld: Pair<Int, Notification>? = null
        private var instance: AgentRunKeepAlive? = null
        private var foregroundId: Int? = null
        private var starting = false

        /** A run's notification is showing: keep the app alive for it. Call again with each update. */
        fun hold(context: Context, id: Int, notification: Notification): Unit = synchronized(lock) {
            held[id] = notification
            lastHeld = id to notification
            val service = instance
            if (service != null) {
                if (foregroundId == null) service.follow()
            } else if (!starting) {
                starting = try {
                    ContextCompat.startForegroundService(context, Intent(context, AgentRunKeepAlive::class.java))
                    true
                } catch (refused: IllegalStateException) {
                    // Started from the background; the run is still followed while the app is in front.
                    false
                }
            }
        }

        /** Call before cancelling the run's notification: the system ignores cancel() on a service's notification. */
        fun release(id: Int): Unit = synchronized(lock) {
            held.remove(id)
            if (foregroundId == id) instance?.follow()
        }
    }
}
