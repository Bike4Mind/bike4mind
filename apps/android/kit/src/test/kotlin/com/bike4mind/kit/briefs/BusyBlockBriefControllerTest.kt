package com.bike4mind.kit.briefs

import com.bike4mind.kit.briefs.CalendarEventSample.Availability
import java.io.IOException
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class BusyBlockBriefControllerTest {
    private val now = Instant.parse("2026-11-25T09:00:00Z")
    private val api = FakeApi()
    private val reader = FakeReader()
    private val saved = mutableListOf<Boolean>()

    private val meeting = CalendarEventSample(
        Instant.parse("2026-11-25T10:00:00Z"),
        Instant.parse("2026-11-25T11:00:00Z"),
        isAllDay = false,
        availability = Availability.BUSY,
    )

    private fun TestScope.controller(
        syncer: BusyBlockSyncer = BusyBlockSyncer(api, reader) { now },
        scope: CoroutineScope = this,
    ) = BusyBlockBriefController(
        api,
        syncer,
        scope,
        io = StandardTestDispatcher(testScheduler),
        onSaved = { saved += it },
    )

    @Test
    fun loadReadsTheServerSetting() = runTest {
        api.enabled = true
        val controller = controller()

        controller.load()
        advanceUntilIdle()

        assertTrue(controller.state.value.isEnabled)
        assertTrue(controller.state.value.isLoaded)
    }

    @Test
    fun aFailedLoadKeepsTheSwitchDisabled() = runTest {
        api.failure = IOException("offline")
        val controller = controller()

        controller.load()
        advanceUntilIdle()

        assertFalse(controller.state.value.isLoaded)
        assertEquals(BusyBlockBriefError.LOAD, controller.state.value.error)
    }

    @Test
    fun turningOnWithoutCalendarAccessStaysOffAndSendsNothing() = runTest {
        val controller = controller()

        controller.setEnabled(true, accessGranted = false)
        advanceUntilIdle()

        assertFalse(controller.state.value.isEnabled)
        assertTrue(controller.state.value.isAccessDenied)
        assertEquals(emptyList(), api.saves)
        assertEquals(emptyList(), saved)
    }

    @Test
    fun turningOnSendsTheCurrentBlocks() = runTest {
        reader.events = listOf(meeting)
        val controller = controller()

        controller.setEnabled(true, accessGranted = true)
        advanceUntilIdle()

        assertEquals(listOf(true to listOf(BusyBlock(meeting.start, meeting.end))), api.saves)
        assertTrue(controller.state.value.isEnabled)
        assertFalse(controller.state.value.isSaving)
        assertFalse(controller.state.value.isAccessDenied)
        assertEquals(listOf(true), saved)
    }

    @Test
    fun turningOffSendsDisabledWithNoBlocks() = runTest {
        api.enabled = true
        reader.events = listOf(meeting)
        val controller = controller()
        controller.load()
        advanceUntilIdle()

        controller.setEnabled(false)
        advanceUntilIdle()

        assertEquals(listOf(false to emptyList<BusyBlock>()), api.saves)
        assertFalse(controller.state.value.isEnabled)
        assertEquals(listOf(false), saved)
    }

    @Test
    fun aFailedSaveRestoresThePreviousValue() = runTest {
        val controller = controller()
        api.saveFailure = IOException("offline")

        controller.setEnabled(true, accessGranted = true)
        advanceUntilIdle()

        assertFalse(controller.state.value.isEnabled)
        assertFalse(controller.state.value.isSaving)
        assertEquals(BusyBlockBriefError.SAVE, controller.state.value.error)
        assertEquals(emptyList(), saved)
    }

    @Test
    fun aSecondTapWhileSavingIsIgnored() = runTest {
        val gate = CompletableDeferred<Unit>()
        api.saveGate = gate
        val controller = controller()

        controller.setEnabled(true, accessGranted = true)
        runCurrent()
        assertTrue(controller.state.value.isSaving)
        controller.setEnabled(false)
        gate.complete(Unit)
        advanceUntilIdle()

        assertEquals(listOf(true), api.saves.map { it.first })
        assertTrue(controller.state.value.isEnabled)
        assertNull(controller.state.value.error)
    }

    @Test
    fun turningOffWaitsForAnInFlightSyncSoTheSyncCannotReEnable() = runTest {
        api.enabled = true
        reader.events = listOf(meeting)
        val syncer = BusyBlockSyncer(api, reader) { now }
        val controller = controller(syncer)
        val gate = CompletableDeferred<Unit>()
        api.saveGate = gate

        val sync = async { syncer.sync(force = true) { saved += it } }
        runCurrent()
        controller.setEnabled(false)
        runCurrent()
        assertEquals(1, api.saves.size)

        api.saveGate = null
        gate.complete(Unit)
        advanceUntilIdle()

        assertEquals(true, sync.await())
        assertEquals(listOf(true, false), api.saves.map { it.first })
        assertEquals(emptyList(), api.saves.last().second)
        assertFalse(api.enabled)
        assertEquals(listOf(true, false), saved)
        assertFalse(controller.state.value.isEnabled)
    }

    @Test
    fun leavingTheScreenWhileTurningOffStillSendsTheDisable() = runTest {
        api.enabled = true
        val screen = Job(coroutineContext[Job])
        val controller = controller(scope = CoroutineScope(coroutineContext + screen))
        val gate = CompletableDeferred<Unit>()
        api.saveGate = gate

        controller.setEnabled(false)
        runCurrent()
        screen.cancel()
        gate.complete(Unit)
        advanceUntilIdle()

        assertFalse(api.enabled)
        assertEquals(listOf(false), saved)
    }

    private class FakeApi : BusyBlocksApi {
        var enabled = false
        var failure: Exception? = null
        var saveFailure: Exception? = null
        var saveGate: CompletableDeferred<Unit>? = null
        val saves = mutableListOf<Pair<Boolean, List<BusyBlock>>>()

        override suspend fun state(): BusyBlocksState {
            failure?.let { throw it }
            return BusyBlocksState(enabled, emptyList())
        }

        override suspend fun save(enabled: Boolean, blocks: List<BusyBlock>): BusyBlocksState {
            saves += enabled to blocks
            saveGate?.await()
            saveFailure?.let { throw it }
            this.enabled = enabled
            return BusyBlocksState(enabled, blocks)
        }
    }

    private class FakeReader : BusyBlockReader {
        var events: List<CalendarEventSample> = emptyList()

        override fun access() = BusyBlockAccess.AUTHORIZED

        override fun events(from: Instant, to: Instant): List<CalendarEventSample> = events
    }
}
