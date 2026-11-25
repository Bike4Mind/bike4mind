package com.bike4mind.app.storage

import android.content.Context
import androidx.core.content.edit
import com.bike4mind.app.BuildConfig
import com.bike4mind.kit.environment.ServerEnvironment

/**
 * Which server this install talks to. Release builds are pinned to production (BuildConfig.SERVER_URL is
 * empty); debug builds default to BuildConfig.SERVER_URL and may be repointed from the sign-in screen.
 */
class EnvironmentStore(context: Context) {
    private val prefs = context.getSharedPreferences("b4m.environment", Context.MODE_PRIVATE)

    val canSwitch: Boolean get() = BuildConfig.DEBUG

    fun current(): ServerEnvironment {
        if (!canSwitch || BuildConfig.SERVER_URL.isEmpty()) return ServerEnvironment.Production
        val url = prefs.getString(BASE_URL, null) ?: BuildConfig.SERVER_URL
        return if (url == ServerEnvironment.Production.baseUrl) ServerEnvironment.Production else ServerEnvironment.Custom(url)
    }

    /** Throws [IllegalArgumentException] for a URL [ServerEnvironment.Custom] would reject. */
    fun save(baseUrl: String) {
        check(canSwitch) { "Release builds always use production" }
        val trimmed = baseUrl.trim().trimEnd('/')
        if (trimmed != ServerEnvironment.Production.baseUrl) ServerEnvironment.Custom(trimmed)
        prefs.edit { putString(BASE_URL, trimmed) }
    }

    private companion object {
        const val BASE_URL = "base_url"
    }
}
