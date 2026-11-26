package com.bike4mind.app.calendar

import android.Manifest
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.CalendarContract
import android.provider.CalendarContract.Attendees
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Instances
import com.bike4mind.kit.briefs.BusyBlockAccess
import com.bike4mind.kit.briefs.CalendarEventSample
import com.bike4mind.kit.briefs.CalendarEventSample.Availability
import java.time.Instant
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CalendarBusyBlockReaderTest {
    private val app = RuntimeEnvironment.getApplication()
    private val permissions = BusyBlockPermissionStore(app)
    private val reader = CalendarBusyBlockReader(app, permissions)

    @Test
    fun theProjectionReadsOnlyTimesAndAvailability() {
        assertArrayEquals(
            arrayOf(Instances.BEGIN, Instances.END, Instances.ALL_DAY, Instances.AVAILABILITY),
            CalendarBusyBlockReader.PROJECTION,
        )
        val privateColumns = setOf(
            Instances.TITLE,
            Instances.DESCRIPTION,
            Instances.EVENT_LOCATION,
            Instances.ORGANIZER,
            Instances.CALENDAR_DISPLAY_NAME,
            Attendees.ATTENDEE_NAME,
            Attendees.ATTENDEE_EMAIL,
        )
        assertTrue(CalendarBusyBlockReader.PROJECTION.none { it in privateColumns })
    }

    @Test
    fun rowsMapToSamples() {
        val cursor = MatrixCursor(CalendarBusyBlockReader.PROJECTION).apply {
            addRow(arrayOf<Any?>(1_000L, 2_000L, 0, Events.AVAILABILITY_TENTATIVE))
            addRow(arrayOf<Any?>(3_000L, 4_000L, 1, Events.AVAILABILITY_FREE))
            addRow(arrayOf<Any?>(5_000L, 6_000L, 0, Events.AVAILABILITY_BUSY))
            addRow(arrayOf<Any?>(7_000L, 8_000L, 0, 99))
            addRow(arrayOf<Any?>(null, 8_000L, 0, Events.AVAILABILITY_BUSY))
        }

        val samples = buildList { while (cursor.moveToNext()) add(CalendarBusyBlockReader.sample(cursor)) }

        assertEquals(
            listOf(
                sample(1_000, 2_000, false, Availability.TENTATIVE),
                sample(3_000, 4_000, true, Availability.FREE),
                sample(5_000, 6_000, false, Availability.BUSY),
                sample(7_000, 8_000, false, Availability.BUSY),
                null,
            ),
            samples,
        )
    }

    @Test
    fun aRevokedPermissionMidQueryReadsNothing() {
        shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR)
        ShadowContentResolver.registerProviderInternal(CalendarContract.AUTHORITY, DenyingProvider())

        assertEquals(emptyList<CalendarEventSample>(), reader.events(Instant.EPOCH, Instant.EPOCH.plusSeconds(60)))
    }

    @Test
    fun eventsQueriesTheWindowExcludingCancelledEvents() {
        shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR)
        val provider = RecordingProvider(
            MatrixCursor(CalendarBusyBlockReader.PROJECTION).apply {
                addRow(arrayOf<Any?>(1_000L, 2_000L, 0, Events.AVAILABILITY_BUSY))
            },
        )
        ShadowContentResolver.registerProviderInternal(CalendarContract.AUTHORITY, provider)

        val events = reader.events(Instant.ofEpochMilli(5_000), Instant.ofEpochMilli(9_000))

        assertEquals(listOf(sample(1_000, 2_000, false, Availability.BUSY)), events)
        assertEquals(Instances.CONTENT_URI.buildUpon().appendPath("5000").appendPath("9000").build(), provider.uri)
        assertArrayEquals(CalendarBusyBlockReader.PROJECTION, provider.projection)
        assertEquals(CalendarBusyBlockReader.SELECTION, provider.selection)
        assertArrayEquals(arrayOf(Events.STATUS_CANCELED.toString()), provider.selectionArgs)
    }

    @Test
    fun accessIsAuthorizedOnlyWhenGranted() {
        shadowOf(app).denyPermissions(Manifest.permission.READ_CALENDAR)
        assertEquals(BusyBlockAccess.NOT_DETERMINED, reader.access())

        permissions.markRequested()
        assertEquals(BusyBlockAccess.DENIED, reader.access())

        shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR)
        assertEquals(BusyBlockAccess.AUTHORIZED, reader.access())
    }

    @Test
    fun aGrantMadeInSystemSettingsReadsAsDeniedOnceRevoked() {
        shadowOf(app).grantPermissions(Manifest.permission.READ_CALENDAR)
        assertEquals(BusyBlockAccess.AUTHORIZED, reader.access())

        shadowOf(app).denyPermissions(Manifest.permission.READ_CALENDAR)
        assertEquals(BusyBlockAccess.DENIED, reader.access())
    }

    @Test
    fun noProviderReadsNothing() {
        assertEquals(emptyList<CalendarEventSample>(), reader.events(Instant.EPOCH, Instant.EPOCH.plusSeconds(60)))
    }

    private fun sample(start: Long, end: Long, allDay: Boolean, availability: Availability) =
        CalendarEventSample(Instant.ofEpochMilli(start), Instant.ofEpochMilli(end), allDay, availability)

    private class RecordingProvider(private val rows: Cursor) : ContentProvider() {
        var uri: Uri? = null
        var projection: Array<out String>? = null
        var selection: String? = null
        var selectionArgs: Array<out String>? = null

        override fun onCreate() = true

        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
            this.uri = uri
            this.projection = projection
            this.selection = selection
            this.selectionArgs = selectionArgs
            return rows
        }

        override fun getType(uri: Uri): String? = null

        override fun insert(uri: Uri, values: ContentValues?): Uri? = null

        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
    }

    private class DenyingProvider : ContentProvider() {
        override fun onCreate() = true

        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor =
            throw SecurityException("READ_CALENDAR revoked")

        override fun getType(uri: Uri): String? = null

        override fun insert(uri: Uri, values: ContentValues?): Uri? = null

        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
    }
}
