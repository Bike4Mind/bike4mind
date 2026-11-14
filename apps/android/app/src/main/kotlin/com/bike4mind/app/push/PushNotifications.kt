package com.bike4mind.app.push

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import com.bike4mind.app.MainActivity
import com.bike4mind.kit.push.PushTokenMemory

/** Channel and foreground display for pushes. The server's FCM payload is `notification` plus string `data`. */
internal object PushNotifications {
    /** Must match `default_notification_channel_id` in AndroidManifest.xml. */
    const val CHANNEL_ID = "b4m_default"

    fun createChannel(context: Context) {
        val channel = NotificationChannel(CHANNEL_ID, "Bike4Mind", NotificationManager.IMPORTANCE_DEFAULT)
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /**
     * FCM hands a notification message to the app instead of the system tray while the app is in the foreground,
     * so it is shown here. Tapping it opens the app.
     */
    @SuppressLint("MissingPermission") // Guarded by areNotificationsEnabled(), which covers POST_NOTIFICATIONS.
    fun show(context: Context, title: String?, body: String?, tag: String?) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        // The tag mirrors the server's collapse tag, so a redelivery replaces the entry instead of stacking.
        manager.notify(tag, 0, notification)
    }
}

/** The last token the server accepted, in plain preferences: an FCM token is an address, not a credential. */
internal class SharedPreferencesPushTokenMemory(context: Context) : PushTokenMemory {
    private val prefs = context.getSharedPreferences("b4m.push", Context.MODE_PRIVATE)

    override suspend fun load(): String? = prefs.getString(KEY, null)

    override suspend fun save(token: String?) = prefs.edit { if (token == null) remove(KEY) else putString(KEY, token) }

    private companion object {
        const val KEY = "serverToken"
    }
}
