package com.bike4mind.app.push

import com.bike4mind.app.B4MApplication
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class B4MMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** FCM issued or rotated the token. The coordinator registers it once a session is active and push is allowed. */
    override fun onNewToken(token: String) {
        val graph = (application as B4MApplication).graph.value ?: return
        scope.launch { graph.push.onDeviceToken(token) }
    }

    /** Only reached for a foreground app; a backgrounded one gets the notification from the system tray. */
    override fun onMessageReceived(message: RemoteMessage) {
        val notification = message.notification ?: return
        PushNotifications.show(this, notification.title, notification.body, tag = notification.tag ?: message.collapseKey)
    }
}
