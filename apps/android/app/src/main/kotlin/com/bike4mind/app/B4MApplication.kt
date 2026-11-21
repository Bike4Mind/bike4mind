package com.bike4mind.app

import android.app.Application
import com.bike4mind.app.push.FcmClient
import com.bike4mind.app.push.PushNotifications
import com.bike4mind.app.storage.EnvironmentStore
import com.bike4mind.app.storage.OnboardingStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Owns the [AppGraph]. A debug build that switches servers gets a fresh graph (and a signed-out session). */
class B4MApplication : Application() {
    private val mutableGraph = MutableStateFlow<AppGraph?>(null)
    val graph: StateFlow<AppGraph?> = mutableGraph.asStateFlow()

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
        FcmClient.initialize(this)
        mutableGraph.value = AppGraph(this, environments.current())
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
