package com.bike4mind.app

import android.content.Context
import androidx.core.content.edit

/**
 * The PKCE verifier and state of the sign-in in flight. Kept on disk because Android may kill the app while
 * the Custom Tab is in front; both are single-use and worthless once the code is exchanged or abandoned.
 */
internal class PendingSignInStore(context: Context) {
    private val prefs = context.getSharedPreferences("b4m.pending_sign_in", Context.MODE_PRIVATE)

    fun save(verifier: String, state: String) = prefs.edit { putString(VERIFIER, verifier).putString(STATE, state) }

    fun load(): Pair<String, String>? {
        val verifier = prefs.getString(VERIFIER, null) ?: return null
        val state = prefs.getString(STATE, null) ?: return null
        return verifier to state
    }

    fun clear() = prefs.edit { clear() }

    private companion object {
        const val VERIFIER = "verifier"
        const val STATE = "state"
    }
}
