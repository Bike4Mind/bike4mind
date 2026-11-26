package com.bike4mind.kit.briefs

import com.bike4mind.kit.briefs.CalendarEventSample.Availability
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class BusyBlockFilterTest {
    private val t0 = Instant.parse("2026-11-25T09:00:00Z")

    private fun event(
        startMinutes: Long,
        length: Duration,
        availability: Availability = Availability.BUSY,
        isAllDay: Boolean = false,
    ): CalendarEventSample {
        val start = t0.plus(Duration.ofMinutes(startMinutes))
        return CalendarEventSample(start, start + length, isAllDay, availability)
    }

    @Test
    fun allDayAndFreeEventsAreNotBusy() {
        val blocks = BusyBlockFilter.blocks(
            listOf(
                event(0, Duration.ofHours(1), isAllDay = true),
                event(0, Duration.ofHours(1), Availability.FREE),
            ),
        )

        assertEquals(emptyList<BusyBlock>(), blocks)
    }

    @Test
    fun tentativeUnavailableAndUnknownAvailabilityCountAsBusy() {
        val blocks = BusyBlockFilter.blocks(
            listOf(
                event(0, Duration.ofHours(1), Availability.TENTATIVE),
                event(60, Duration.ofHours(1), Availability.UNAVAILABLE),
                event(120, Duration.ofHours(1), Availability.NOT_SUPPORTED),
            ),
        )

        assertEquals(3, blocks.size)
    }

    @Test
    fun emptyInvertedAndOverlongBlocksAreDroppedNotClipped() {
        val twelveHours = event(0, BusyBlockFilter.MAX_DURATION)
        val blocks = BusyBlockFilter.blocks(
            listOf(
                event(0, Duration.ZERO),
                event(0, Duration.ofMinutes(-30)),
                twelveHours,
                event(0, BusyBlockFilter.MAX_DURATION.plusMillis(1)),
            ),
        )

        assertEquals(listOf(BusyBlock(twelveHours.start, twelveHours.end)), blocks)
    }

    @Test
    fun blocksAreOrderedByEndThenStart() {
        val late = event(0, Duration.ofHours(3))
        val earlyLong = event(0, Duration.ofHours(1))
        val earlyShort = event(30, Duration.ofMinutes(30))

        val blocks = BusyBlockFilter.blocks(listOf(late, earlyShort, earlyLong))

        assertEquals(listOf(earlyLong.start, earlyShort.start, late.start), blocks.map { it.start })
    }

    @Test
    fun onlyTheSoonestEndingBlocksUpToTheServerCapAreKept() {
        val events = (0 until 60L).reversed().map { event(it * 10, Duration.ofMinutes(5)) }

        val blocks = BusyBlockFilter.blocks(events)

        assertEquals(BusyBlockFilter.MAX_BLOCKS, blocks.size)
        assertEquals(t0, blocks.first().start)
        assertEquals(t0.plus(Duration.ofMinutes(47 * 10)), blocks.last().start)
    }
}
