package com.bike4mind.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import androidx.lifecycle.lifecycleScope
import com.bike4mind.app.calendar.BusyBlockSyncWorker
import com.bike4mind.app.ui.AppRoot
import com.bike4mind.app.ui.B4MTheme
import com.bike4mind.kit.links.IncomingUri
import com.bike4mind.kit.links.PendingRoute
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.push.PushRoute
import com.bike4mind.kit.shortcuts.AppShortcut
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val signInError = MutableStateFlow<String?>(null)
    private val pendingRoute = PendingRoute()

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { syncNotificationPermission() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as B4MApplication
        if (savedInstanceState != null) {
            pendingRoute.restore(savedInstanceState.getString(PENDING_ROUTE_KEY))
        }
        setContent {
            B4MTheme {
                // Exposes Compose test tags as resource ids, which is how the shared Maestro flows address elements.
                // The Surface gives screens without a Scaffold (welcome, sign-in, upgrade) the theme background and
                // content color instead of the light window behind them.
                Surface(
                    modifier = Modifier.fillMaxSize().semantics { testTagsAsResourceId = true },
                    color = MaterialTheme.colorScheme.background,
                ) {
                    AppRoot(
                        app = app,
                        signInError = signInError,
                        pendingRoute = pendingRoute.route,
                        onRouteConsumed = { route -> pendingRoute.consume(route) },
                        onSignedIn = ::askForNotificationsOnce,
                    )
                }
            }
        }
        if (savedInstanceState == null) handleIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(PENDING_ROUTE_KEY, pendingRoute.snapshot())
    }

    override fun onResume() {
        super.onResume()
        // The user may have changed the notification setting while the app was away.
        syncNotificationPermission()
        syncBusyBlocks()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        // A launcher shortcut (res/xml/shortcuts.xml) waits through sign-in like a link.
        AppShortcut.fromAction(intent?.action)?.let { return open(it.route) }
        val uri = intent?.data?.toString() ?: return handlePushTap(intent)
        val graph = (application as B4MApplication).graph.value ?: return
        when (val incoming = IncomingUri.classify(uri, graph.oauth, graph.environment.baseUrl)) {
            IncomingUri.SignInCallback -> handleCallback(uri)
            is IncomingUri.Link -> open(incoming.route)
            null -> Unit
        }
    }

    /**
     * A tapped push: the system tray hands FCM's `data` over as the launch intent's extras, and the foreground
     * notification (PushNotifications.show) copies them the same way.
     */
    private fun handlePushTap(intent: Intent?) {
        val extras = intent?.extras ?: return
        PushRoute.from({ extras.getString(it) }, serverBaseUrl())?.let(::open)
    }

    /** AppRoot opens an in-app route once signed in; a web page (no native screen) needs no sign-in. */
    private fun open(route: Route) {
        if (route is Route.Web) openInBrowser(route.url) else pendingRoute.accept(route)
    }

    /**
     * Hands the page to a browser by package: a plain VIEW intent for a link the manifest claims would come straight
     * back to this activity. With no browser the app stays where it is.
     */
    private fun openInBrowser(url: String) {
        val browser = browserPackage() ?: return
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(browser)
        try {
            startActivity(view)
        } catch (_: ActivityNotFoundException) {
            // The browser went away between the lookup and the launch.
        }
    }

    /** The default browser, else any installed one; never this app. Visible through the manifest's <queries>. */
    private fun browserPackage(): String? {
        // A URL no app claims, so only browsers answer it.
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")).addCategory(Intent.CATEGORY_BROWSABLE)
        val default = resolveActivityCompat(probe)?.activityInfo?.packageName
        // "android" is the system chooser, answering when no default browser is set.
        if (default != null && default != "android" && default != packageName) return default
        return queryActivitiesCompat(probe).map { it.activityInfo.packageName }.firstOrNull { it != packageName }
    }

    private fun resolveActivityCompat(intent: Intent): ResolveInfo? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.resolveActivity(intent, PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong()))
        } else {
            @Suppress("DEPRECATION")
            packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)
        }

    private fun queryActivitiesCompat(intent: Intent): List<ResolveInfo> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            packageManager.queryIntentActivities(intent, 0)
        }

    private fun serverBaseUrl(): String? = (application as B4MApplication).graph.value?.environment?.baseUrl

    private fun syncNotificationPermission() {
        val graph = (application as B4MApplication).graph.value ?: return
        val allowed = NotificationManagerCompat.from(this).areNotificationsEnabled()
        lifecycleScope.launch { graph.push.onNotificationsAllowed(allowed) }
    }

    // The calendar may have changed while the app was away; the syncer's throttle absorbs quick re-resumes.
    private fun syncBusyBlocks() {
        val graph = (application as B4MApplication).graph.value ?: return
        lifecycleScope.launch(Dispatchers.IO) { BusyBlockSyncWorker.syncInForeground(applicationContext, graph) }
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
    private fun handleCallback(uri: String) {
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
                failure.message ?: getString(R.string.signin_failed)
            }
        }
    }

    private companion object {
        const val PENDING_ROUTE_KEY = "b4m.pendingRoute"
    }
}
