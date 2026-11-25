package com.bike4mind.kit.briefs

import com.bike4mind.kit.briefs.CalendarEventSample.Availability
import java.io.IOException
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class BusyBlockSyncerTest {
    private var now = Instant.parse("2026-11-25T09:00:00Z")
    private val api = FakeApi()
    private val reader = FakeReader()
    private val syncer = BusyBlockSyncer(api, reader) { now }

    private val meeting = CalendarEventSample(
        Instant.parse("2026-11-25T10:00:00Z"),
        Instant.parse("2026-11-25T11:00:00Z"),
        isAllDay = false,
        availability = Availability.BUSY,
    )

    @Test
    fun aDeviceNeverAskedForAccessMakesNoCalls() = runTest {
        reader.access = BusyBlockAccess.NOT_DETERMINED

        assertNull(syncer.sync(force = true))
        assertEquals(0, api.stateCalls)
        assertEquals(0, api.saves.size)
    }

    @Test
    fun anAccountThatNeverOptedInIsNeverWritten() = runTest {
        api.enabled = false

        assertEquals(false, syncer.sync())
        assertEquals(1, api.stateCalls)
        assertEquals(0, api.saves.size)
    }

    @Test
    fun anEnabledAccountGetsTheFilteredBlocks() = runTest {
        reader.events = listOf(meeting)

        assertEquals(true, syncer.sync())
        assertEquals(listOf(true to listOf(BusyBlock(meeting.start, meeting.end))), api.saves)
        assertEquals(now - BusyBlockFilter.LOOK_BEHIND to now + BusyBlockFilter.LOOK_AHEAD, reader.lastWindow)
    }

    @Test
    fun aRevokedPermissionClearsBlocksButKeepsTheOptIn() = runTest {
        reader.access = BusyBlockAccess.DENIED
        reader.events = listOf(meeting)

        assertEquals(true, syncer.sync())
        assertEquals(listOf(true to emptyList<BusyBlock>()), api.saves)
        assertNull(reader.lastWindow)
    }

    @Test
    fun syncsInsideTheMinimumIntervalAreSkippedUnlessForced() = runTest {
        syncer.sync()
        now += BusyBlockSyncer.MIN_INTERVAL.minusSeconds(1)
        assertNull(syncer.sync())
        assertEquals(1, api.saves.size)

        assertEquals(true, syncer.sync(force = true))
        assertEquals(2, api.saves.size)

        now += Duration.ofSeconds(61)
        assertEquals(true, syncer.sync())
        assertEquals(3, api.saves.size)
    }

    @Test
    fun overlappingSyncsSendOnePut() = runTest {
        val gate = CompletableDeferred<Unit>()
        api.stateGate = gate

        val first = async { syncer.sync(force = true) }
        runCurrent()
        val second = async { syncer.sync(force = true) }
        runCurrent()
        gate.complete(Unit)

        assertEquals(true, first.await())
        assertNull(second.await())
        assertEquals(1, api.saves.size)
    }

    @Test
    fun aFailedSyncReturnsNullAndTheNextCallRetries() = runTest {
        api.failure = IOException("offline")
        assertNull(syncer.sync())

        api.failure = null
        assertEquals(true, syncer.sync())
        assertEquals(1, api.saves.size)
    }

    @Test
    fun aSyncStartedDuringAUserSaveIsSkipped() = runTest {
        val gate = CompletableDeferred<Unit>()
        val save = async { syncer.userSave { gate.await() } }
        runCurrent()

        assertNull(syncer.sync(force = true))
        assertEquals(0, api.stateCalls)
        gate.complete(Unit)
        save.await()
    }

    @Test
    fun aUserSaveRunsAfterTheInFlightSyncHasActedOnItsResult() = runTest {
        val order = mutableListOf<String>()
        val gate = CompletableDeferred<Unit>()
        api.stateGate = gate

        val sync = async { syncer.sync(force = true) { order += "sync:$it" } }
        runCurrent()
        val save = async { syncer.userSave { order += "user" } }
        runCurrent()
        assertEquals(emptyList(), order)
        gate.complete(Unit)

        assertEquals(true, sync.await())
        save.await()
        assertEquals(listOf("sync:true", "user"), order)
    }

    @Test
    fun resetLetsTheNextAccountSyncInsideTheInterval() = runTest {
        assertEquals(true, syncer.sync())
        now += Duration.ofSeconds(5)
        syncer.reset()

        assertEquals(true, syncer.sync())
        assertEquals(2, api.saves.size)
    }

    private class FakeApi : BusyBlocksApi {
        var enabled = true
        var failure: Exception? = null
        var stateGate: CompletableDeferred<Unit>? = null
        var stateCalls = 0
        val saves = mutableListOf<Pair<Boolean, List<BusyBlock>>>()

        override suspend fun state(): BusyBlocksState {
            stateCalls++
            stateGate?.await()
            failure?.let { throw it }
            return BusyBlocksState(enabled, emptyList())
        }

        override suspend fun save(enabled: Boolean, blocks: List<BusyBlock>): BusyBlocksState {
            saves += enabled to blocks
            return BusyBlocksState(enabled, blocks)
        }
    }

    private class FakeReader : BusyBlockReader {
        var access = BusyBlockAccess.AUTHORIZED
        var events: List<CalendarEventSample> = emptyList()
        var lastWindow: Pair<Instant, Instant>? = null

        override fun access() = access

        override fun events(from: Instant, to: Instant): List<CalendarEventSample> {
            lastWindow = from to to
            return events
        }
    }
}
