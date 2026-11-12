package com.bike4mind.app.ui

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bike4mind.app.AppGraph
import com.bike4mind.app.B4MApplication
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** Sign-in runs the server's own web flow (email, Google, ...) in a Custom Tab; the redirect returns to MainActivity. */
@Composable
fun SignInScreen(app: B4MApplication, graph: AppGraph, signInError: MutableStateFlow<String?>) {
    val context = LocalContext.current
    val error by signInError.collectAsStateWithLifecycle()

    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Bike4Mind", style = MaterialTheme.typography.headlineLarge)
        Button(onClick = {
            signInError.value = null
            CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(graph.beginSignIn()))
        }) {
            Text("Sign in")
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (app.environments.canSwitch) ServerPicker(app = app, current = graph.environment.baseUrl)
    }
}

@Composable
private fun ServerPicker(app: B4MApplication, current: String) {
    val scope = rememberCoroutineScope()
    var url by remember(current) { mutableStateOf(current) }
    var problem by remember { mutableStateOf<String?>(null) }

    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Server (debug builds only)", style = MaterialTheme.typography.labelLarge)
        OutlinedTextField(value = url, onValueChange = { url = it }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedButton(enabled = url.trim().trimEnd('/') != current, onClick = {
            scope.launch {
                problem = try {
                    app.switchServer(url)
                    null
                } catch (invalid: IllegalArgumentException) {
                    invalid.message
                }
            }
        }) {
            Text("Use this server")
        }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}
