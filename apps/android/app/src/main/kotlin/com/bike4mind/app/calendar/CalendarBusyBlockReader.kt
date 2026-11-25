package com.bike4mind.app.calendar

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Instances
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.bike4mind.kit.briefs.BusyBlockAccess
import com.bike4mind.kit.briefs.BusyBlockReader
import com.bike4mind.kit.briefs.CalendarEventSample
import com.bike4mind.kit.briefs.CalendarEventSample.Availability
import java.time.Instant

/** Whether this install has ever asked for calendar access, which Android cannot report outside an Activity. */
class BusyBlockPermissionStore(context: Context) {
    private val prefs = context.getSharedPreferences("b4m.busy_blocks", Context.MODE_PRIVATE)

    val requested: Boolean get() = prefs.getBoolean(REQUESTED, false)

    fun markRequested() = prefs.edit { putBoolean(REQUESTED, true) }

    private companion object {
        const val REQUESTED = "calendar_requested"
    }
}

/**
 * Reads event times from the device calendar for busy-block briefs. Only [PROJECTION]'s columns are ever read:
 * no title, description, location, organizer or attendee leaves the provider.
 */
class CalendarBusyBlockReader(
    private val context: Context,
    private val permissions: BusyBlockPermissionStore,
) : BusyBlockReader {
    override fun access(): BusyBlockAccess = when {
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED -> {
            // A grant made in system settings never passed through the request, and a later revoke must read as denied.
            if (!permissions.requested) permissions.markRequested()
            BusyBlockAccess.AUTHORIZED
        }
        permissions.requested -> BusyBlockAccess.DENIED
        else -> BusyBlockAccess.NOT_DETERMINED
    }

    override fun events(from: Instant, to: Instant): List<CalendarEventSample> {
        val uri = Instances.CONTENT_URI.buildUpon()
            .also {
                ContentUris.appendId(it, from.toEpochMilli())
                ContentUris.appendId(it, to.toEpochMilli())
            }
            .build()
        return try {
            context.contentResolver.query(uri, PROJECTION, SELECTION, arrayOf(Events.STATUS_CANCELED.toString()), null)
                ?.use { cursor -> buildList { while (cursor.moveToNext()) sample(cursor)?.let(::add) } }
                .orEmpty()
        } catch (revoked: SecurityException) {
            emptyList()
        }
    }

    internal companion object {
        val PROJECTION = arrayOf(Instances.BEGIN, Instances.END, Instances.ALL_DAY, Instances.AVAILABILITY)

        // A NULL status is a normal event, and SQL drops NULL from a bare `!=`.
        const val SELECTION = "(${Instances.STATUS} IS NULL OR ${Instances.STATUS} != ?)"

        /** Maps one row read with [PROJECTION]; a row without times is skipped. */
        fun sample(cursor: Cursor): CalendarEventSample? {
            if (cursor.isNull(0) || cursor.isNull(1)) return null
            return CalendarEventSample(
                start = Instant.ofEpochMilli(cursor.getLong(0)),
                end = Instant.ofEpochMilli(cursor.getLong(1)),
                isAllDay = cursor.getInt(2) == 1,
                availability = when (cursor.getInt(3)) {
                    Events.AVAILABILITY_FREE -> Availability.FREE
                    Events.AVAILABILITY_TENTATIVE -> Availability.TENTATIVE
                    else -> Availability.BUSY
                },
            )
        }
    }
}
