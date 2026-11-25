package com.bike4mind.kit.briefs

import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Read-only access to the device calendar. The CalendarContract implementation lives in the app module. */
interface BusyBlockReader {
    fun access(): BusyBlockAccess

    fun events(from: Instant, to: Instant): List<CalendarEventSample>
}

enum class BusyBlockAccess { NOT_DETERMINED, AUTHORIZED, DENIED }

/**
 * Pushes the device's upcoming busy blocks to the server while the user has busy-block briefs on. Twin of apps/ios
 * BusyBlockSyncer. The server's opt-in is read first, so an account that never enabled the feature is never
 * written; a device never asked for calendar access skips the request entirely, since enabling always asks.
 */
class BusyBlockSyncer(
    private val api: BusyBlocksApi,
    private val reader: BusyBlockReader,
    private val clock: () -> Instant = Instant::now,
) {
    private val inFlight = Mutex()

    @Volatile
    private var lastSync: Instant? = null

    /** Blocks from the device calendar for the sync horizon; empty when access is off. */
    fun currentBlocks(): List<BusyBlock> {
        if (reader.access() != BusyBlockAccess.AUTHORIZED) return emptyList()
        val at = clock()
        return BusyBlockFilter.blocks(reader.events(at - BusyBlockFilter.LOOK_BEHIND, at + BusyBlockFilter.LOOK_AHEAD))
    }

    /**
     * Returns the server's opt-in, or null when the sync was skipped or failed. A revoked calendar permission
     * syncs an empty list, so stale blocks stop holding pushes. [onResult] gets the opt-in before the lock is
     * released, so a host acting on it cannot interleave with a [userSave].
     */
    suspend fun sync(force: Boolean = false, onResult: (Boolean) -> Unit = {}): Boolean? {
        if (reader.access() == BusyBlockAccess.NOT_DETERMINED) return null
        if (!inFlight.tryLock()) return null
        try {
            val last = lastSync
            if (!force && last != null && Duration.between(last, clock()) < MIN_INTERVAL) return null
            if (!api.state().enabled) {
                lastSync = clock()
                onResult(false)
                return false
            }
            api.save(enabled = true, blocks = currentBlocks())
            lastSync = clock()
            onResult(true)
            return true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failed: Exception) {
            // Signed out or offline: the next foreground or calendar change retries.
            return null
        } finally {
            inFlight.unlock()
        }
    }

    /**
     * Runs the user's own save under the sync lock: an in-flight sync finishes first and one started meanwhile is
     * skipped, so a sync that read the opt-in before the user turned it off can never re-enable it.
     */
    suspend fun <T> userSave(save: suspend () -> T): T = inFlight.withLock { save() }

    /** Forgets the throttle, so the next account's first sync is not skipped. */
    fun reset() {
        lastSync = null
    }

    companion object {
        /** Foreground and calendar-change syncs closer together than this are skipped. */
        val MIN_INTERVAL: Duration = Duration.ofSeconds(60)
    }
}
