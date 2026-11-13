package com.bike4mind.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel

/**
 * Holds the view model store of the one screen AppRoot shows. Itself Activity-scoped, so the screen's view
 * models survive rotation; moving to a screen with a different key clears the previous screen's store, which
 * is what stops a closed chat's realtime socket and drops one account's data when another signs in.
 */
internal class ScreenStores : ViewModel() {
    private var currentKey: Any? = null
    private var current = ViewModelStore()

    fun storeFor(key: Any): ViewModelStore {
        if (key != currentKey) {
            current.clear()
            current = ViewModelStore()
            currentKey = key
        }
        return current
    }

    override fun onCleared() {
        current.clear()
    }
}

/** Gives [content] view models that live exactly as long as [key] stays the shown screen. */
@Composable
internal fun ScreenScope(key: Any, content: @Composable () -> Unit) {
    val stores = viewModel { ScreenStores() }
    val owner = remember(stores, key) {
        val store = stores.storeFor(key)
        object : ViewModelStoreOwner {
            override val viewModelStore = store
        }
    }
    CompositionLocalProvider(LocalViewModelStoreOwner provides owner, content = content)
}
