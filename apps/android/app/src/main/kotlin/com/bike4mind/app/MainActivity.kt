package com.bike4mind.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import androidx.lifecycle.lifecycleScope
import com.bike4mind.app.ui.AppRoot
import com.bike4mind.app.ui.B4MTheme
import com.bike4mind.kit.push.NotificationRoute
import com.bike4mind.kit.push.PendingNotificationRoute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val signInError = MutableStateFlow<String?>(null)
    private val pendingPush = PendingNotificationRoute()

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { syncNotificationPermission() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as B4MApplication
        if (savedInstanceState != null) {
            pendingPush.restoreBriefId(savedInstanceState.getString(PENDING_BRIEF_KEY))
        }
        setContent {
            B4MTheme {
                // Exposes Compose test tags as resource ids, which is how the shared Maestro flows address elements.
                Box(Modifier.semantics { testTagsAsResourceId = true }) {
                    AppRoot(
                        app = app,
                        signInError = signInError,
                        pushRoute = pendingPush.route,
                        onPushRouteConsumed = { route -> pendingPush.consume(route) },
                        onSignedIn = ::askForNotificationsOnce,
                    )
                }
            }
        }
        if (savedInstanceState == null) handleIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(PENDING_BRIEF_KEY, pendingPush.snapshotBriefId())
    }

    override fun onResume() {
        super.onResume()
        // The user may have changed the notification setting while the app was away.
        syncNotificationPermission()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        handlePushTap(intent)
        handleCallback(intent)
    }

    /**
     * A tapped push: the system tray hands FCM's `data` over as the launch intent's extras, and the foreground
     * notification (PushNotifications.show) copies them the same way. AppRoot opens the route once signed in.
     */
    private fun handlePushTap(intent: Intent?) {
        val extras = intent?.extras ?: return
        NotificationRoute.from { extras.getString(it) }?.let(pendingPush::accept)
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

    private companion object {
        const val PENDING_BRIEF_KEY = "b4m.pendingBriefId"
    }
}
