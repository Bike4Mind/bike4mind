package com.bike4mind.app.calendar

import android.provider.CalendarContract
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class BusyBlockSyncWorkerTest {
    private val app = RuntimeEnvironment.getApplication()

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(
            app,
            Configuration.Builder().setExecutor(SynchronousExecutor()).build(),
        )
    }

    private fun work(): List<WorkInfo> = WorkManager.getInstance(app).getWorkInfosForUniqueWork(BusyBlockSyncWorker.NAME).get()

    @Test
    fun armingWaitsOnAnyChangeUnderTheCalendarProvider() {
        BusyBlockSyncWorker.arm(app)

        val armed = work().single()
        assertEquals(WorkInfo.State.ENQUEUED, armed.state)
        val trigger = armed.constraints.contentUriTriggers.single()
        assertEquals(CalendarContract.CONTENT_URI, trigger.uri)
        assertTrue(trigger.isTriggeredForDescendants)
        assertEquals(NetworkType.CONNECTED, armed.constraints.requiredNetworkType)
    }

    @Test
    fun repeatedForegroundArmsKeepASingleTrigger() {
        BusyBlockSyncWorker.arm(app)
        BusyBlockSyncWorker.arm(app)
        BusyBlockSyncWorker.follow(app, true)
        BusyBlockSyncWorker.follow(app, null)

        assertEquals(1, work().size)
    }

    @Test
    fun turningTheFeatureOffDropsTheTrigger() {
        BusyBlockSyncWorker.arm(app)

        BusyBlockSyncWorker.follow(app, false)

        assertEquals(listOf(WorkInfo.State.CANCELLED), work().map { it.state })
    }

    @Test
    fun cancellingDropsTheArmedTrigger() {
        BusyBlockSyncWorker.arm(app)

        BusyBlockSyncWorker.cancel(app)

        assertEquals(listOf(WorkInfo.State.CANCELLED), work().map { it.state })
    }

    @Test
    fun endingTheSessionDropsTheTriggerAndResetsTheThrottle() {
        BusyBlockSyncWorker.arm(app)
        var resets = 0

        BusyBlockSyncWorker.endSession(app) { resets++ }

        assertEquals(listOf(WorkInfo.State.CANCELLED), work().map { it.state })
        assertEquals(1, resets)
    }

    @Test
    fun aRunWhileSignedOutNeitherSyncsNorReArms() = runTest {
        var syncs = 0
        var rearms = 0

        val result = BusyBlockSyncWorker.settle(signedIn = false, sync = { syncs++; true }, rearm = { rearms++ })

        assertEquals(ListenableWorker.Result.success(), result)
        assertEquals(0, syncs)
        assertEquals(0, rearms)
    }

    @Test
    fun aRunReArmsUnlessTheServerSaysOff() = runTest {
        for ((enabled, expectedRearms) in listOf(true to 1, null to 1, false to 0)) {
            var rearms = 0

            BusyBlockSyncWorker.settle(signedIn = true, sync = { enabled }, rearm = { rearms++ })

            assertEquals("sync returned $enabled", expectedRearms, rearms)
        }
    }
}
