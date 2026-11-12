package com.bike4mind.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import com.bike4mind.app.ui.AppRoot
import com.bike4mind.app.ui.B4MTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val signInError = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as B4MApplication
        setContent {
            B4MTheme {
                AppRoot(app = app, signInError = signInError)
            }
        }
        if (savedInstanceState == null) handleCallback(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleCallback(intent)
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
            } catch (failure: Exception) {
                failure.message ?: "Sign-in failed"
            }
        }
    }
}
