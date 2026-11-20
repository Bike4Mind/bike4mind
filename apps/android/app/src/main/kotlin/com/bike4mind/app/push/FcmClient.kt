package com.bike4mind.app.push

import android.content.Context
import com.bike4mind.app.BuildConfig
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Firebase set up from build-time properties (`b4m.fcm.*`, see app/build.gradle.kts) instead of a committed
 * google-services.json. With no config the app runs normally and simply never gets a push token.
 */
object FcmClient {
    private val configured: Boolean
        get() = listOf(
            BuildConfig.FCM_APPLICATION_ID,
            BuildConfig.FCM_API_KEY,
            BuildConfig.FCM_PROJECT_ID,
            BuildConfig.FCM_SENDER_ID,
        ).all { it.isNotBlank() }

    /** Idempotent. Returns whether Firebase is usable in this build. */
    fun initialize(context: Context): Boolean {
        if (!configured) return false
        if (FirebaseApp.getApps(context).isEmpty()) {
            val options = FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FCM_APPLICATION_ID)
                .setApiKey(BuildConfig.FCM_API_KEY)
                .setProjectId(BuildConfig.FCM_PROJECT_ID)
                .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                .build()
            FirebaseApp.initializeApp(context, options)
        }
        return true
    }

    /** This install's current FCM registration token, or null when Firebase is not configured or the fetch failed. */
    suspend fun currentToken(context: Context): String? {
        if (!initialize(context)) return null
        return suspendCancellableCoroutine { continuation ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (continuation.isActive) continuation.resume(if (task.isSuccessful) task.result else null)
            }
        }
    }
}
