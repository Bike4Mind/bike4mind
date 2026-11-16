package com.bike4mind.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import androidx.lifecycle.lifecycleScope
import com.bike4mind.app.ui.AppRoot
import com.bike4mind.app.ui.B4MTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val signInError = MutableStateFlow<String?>(null)

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { syncNotificationPermission() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as B4MApplication
        setContent {
            B4MTheme {
                AppRoot(app = app, signInError = signInError, onSignedIn = ::askForNotificationsOnce)
            }
        }
        if (savedInstanceState == null) handleCallback(intent)
    }

    override fun onResume() {
        super.onResume()
        // The user may have changed the notification setting while the app was away.
        syncNotificationPermission()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleCallback(intent)
    }

    private fun syncNotificationPermission() {
        val graph = (application as B4MApplication).graph.value ?: return
        val allowed = NotificationManagerCompat.from(this).areNotificationsEnabled()
        lifecycleScope.launch { graph.push.onNotificationsAllowed(allowed) }
    }

    /** Android 13+ needs a runtime grant; ask at the first signed-in moment, once per install. */
    private fun askForNotificationsOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (NotificationManagerCompat.from(this).areNotificationsEnabled()) return
        val prefs = getSharedPreferences("b4m.push", MODE_PRIVATE)
        if (prefs.getBoolean("permissionAsked", false)) return
        prefs.edit { putBoolean("permissionAsked", true) }
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** The OAuth redirect lands here (singleTask), from the Custom Tab the sign-in screen opened. */
    private fun handleCallback(intent: Intent?) {
        val uri = intent?.data?.toString() ?: return
        val graph = (application as B4MApplication).graph.value ?: return
        lifecycleScope.launch {
            signInError.value = try {
                when (val outcome = graph.completeSignIn(uri)) {
                    is SignInOutcome.Failed -> outcome.reason
                    else -> null
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                failure.message ?: "Sign-in failed"
            }
        }
    }
}
