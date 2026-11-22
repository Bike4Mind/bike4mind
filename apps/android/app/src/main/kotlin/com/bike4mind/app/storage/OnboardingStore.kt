package com.bike4mind.app.storage

import android.content.Context
import androidx.core.content.edit
import com.bike4mind.kit.onboarding.Onboarding
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether this install has finished the first-launch welcome. Per install, not per server: allowBackup is off,
 * so a reinstall starts over. The first read records its answer, so a later update cannot skip a welcome that a
 * fresh install has not finished yet.
 */
class OnboardingStore(context: Context) {
    private val prefs = context.getSharedPreferences("b4m.onboarding", Context.MODE_PRIVATE)
    private val completed = MutableStateFlow(resolve(context))

    val isCompleted: StateFlow<Boolean> = completed.asStateFlow()

    fun complete() {
        if (completed.value) return
        prefs.edit { putBoolean(COMPLETED, true) }
        completed.value = true
    }

    private fun resolve(context: Context): Boolean {
        val recorded = if (prefs.contains(COMPLETED)) prefs.getBoolean(COMPLETED, false) else null
        val value = Onboarding.initialCompleted(recorded, isUpgrade = recorded == null && wasUpdated(context))
        if (recorded == null) prefs.edit { putBoolean(COMPLETED, value) }
        return value
    }

    // An install that has been updated since it was first installed predates this build's welcome.
    private fun wasUpdated(context: Context): Boolean {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return info.lastUpdateTime > info.firstInstallTime
    }

    private companion object {
        const val COMPLETED = "completed"
    }
}
