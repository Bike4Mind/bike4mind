package com.bike4mind.kit.briefs

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class BusyBlockBriefError { LOAD, SAVE }

data class BusyBlockBriefState(
    val isEnabled: Boolean = false,
    /** False until the server's setting has been read once; the switch stays disabled until then. */
    val isLoaded: Boolean = false,
    val isSaving: Boolean = false,
    /** The last attempt to turn it on was refused calendar access. */
    val isAccessDenied: Boolean = false,
    val error: BusyBlockBriefError? = null,
)

/**
 * Drives the "Brief after busy blocks" switch in Settings > Notifications. Twin of apps/ios BusyBlockBriefViewModel,
 * except that the permission request belongs to the host: it asks, then passes the answer to [setEnabled].
 * [onSaved] gets the server's opt-in after each save, so the host can start or stop its calendar-change trigger; it
 * runs on [io] under the syncer's lock, ordered after any in-flight sync's own result.
 */
class BusyBlockBriefController(
    private val api: BusyBlocksApi,
    private val syncer: BusyBlockSyncer,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val onSaved: (Boolean) -> Unit = {},
) {
    private val mutableState = MutableStateFlow(BusyBlockBriefState())
    val state: StateFlow<BusyBlockBriefState> = mutableState.asStateFlow()

    fun load() {
        scope.launch {
            try {
                val enabled = api.state().enabled
                mutableState.update { it.copy(isEnabled = enabled, isLoaded = true, error = null) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failed: Exception) {
                mutableState.update { it.copy(error = BusyBlockBriefError.LOAD) }
            }
        }
    }

    /** Turning it on without [accessGranted] leaves it off and flags the denial; nothing is sent. */
    fun setEnabled(on: Boolean, accessGranted: Boolean = true) {
        val current = mutableState.value
        if (current.isSaving) return
        if (on && !accessGranted) {
            mutableState.update { it.copy(isEnabled = false, isAccessDenied = true, error = null) }
            return
        }
        val previous = current.isEnabled
        mutableState.update {
            it.copy(isEnabled = on, isSaving = true, isAccessDenied = if (on) false else it.isAccessDenied, error = null)
        }
        scope.launch {
            try {
                // Turning off must reach the server even if the user leaves the screen mid-request.
                val saved = withContext(if (on) io else io + NonCancellable) {
                    syncer.userSave {
                        api.save(enabled = on, blocks = if (on) syncer.currentBlocks() else emptyList()).also { onSaved(it.enabled) }
                    }
                }
                mutableState.update { it.copy(isEnabled = saved.enabled, isSaving = false) }
            } catch (cancelled: CancellationException) {
                mutableState.update { it.copy(isEnabled = previous, isSaving = false) }
                throw cancelled
            } catch (failed: Exception) {
                mutableState.update { it.copy(isEnabled = previous, isSaving = false, error = BusyBlockBriefError.SAVE) }
            }
        }
    }
}
