package com.bike4mind.app

import android.app.Application
import android.util.Log
import com.bike4mind.app.calendar.BusyBlockSyncWorker
import com.bike4mind.app.capture.CaptureWorker
import com.bike4mind.app.push.AgentRunNotifications
import com.bike4mind.app.push.FcmClient
import com.bike4mind.app.push.PushNotifications
import com.bike4mind.app.storage.EnvironmentStore
import com.bike4mind.app.storage.OnboardingStore
import com.bike4mind.kit.capture.CaptureStage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Owns the [AppGraph]. A debug build that switches servers gets a fresh graph (and a signed-out session). */
class B4MApplication : Application() {
    private val mutableGraph = MutableStateFlow<AppGraph?>(null)
    val graph: StateFlow<AppGraph?> = mutableGraph.asStateFlow()

    /** Work that outlives any screen, such as scheduling a share's upload after the share screen closed. */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    lateinit var environments: EnvironmentStore
        private set

    /** Per install, so a debug server switch does not bring the welcome back. */
    lateinit var onboarding: OnboardingStore
        private set

    override fun onCreate() {
        super.onCreate()
        environments = EnvironmentStore(this)
        onboarding = OnboardingStore(this)
        PushNotifications.createChannel(this)
        AgentRunNotifications.createChannel(this)
        FcmClient.initialize(this)
        mutableGraph.value = AppGraph(this, environments.current())
        // A share the system stopped (an update, a reboot) carries on once the app runs again.
        val graph = mutableGraph.value
        scope.launch {
            val capture = graph?.capture ?: return@launch
            capture.load()
            if (capture.jobs.value.any { it.stage == CaptureStage.PENDING }) CaptureWorker.schedule(this@B4MApplication)
        }
        // A revoked calendar permission kills the process without restarting it, so the next launch is where the
        // blocks get cleared; it also re-arms a trigger the worker gave up on.
        scope.launch {
            val current = graph ?: return@launch
            try {
                current.session.restore()
                BusyBlockSyncWorker.syncInForeground(this@B4MApplication, current)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failed: Exception) {
                Log.w("B4MBusyBlocks", "Busy-block sync at launch failed", failed)
            }
        }
    }

    /** Debug only: points the app at another server. Tokens are per server, so the old ones are dropped. */
    suspend fun switchServer(baseUrl: String) {
        val previous = mutableGraph.value
        environments.save(baseUrl)
        previous?.signOutLocally()
        previous?.close()
        mutableGraph.value = AppGraph(this, environments.current())
    }
}
