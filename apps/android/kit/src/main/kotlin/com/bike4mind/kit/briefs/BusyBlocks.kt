package com.bike4mind.kit.briefs

import java.time.Duration
import java.time.Instant

/**
 * A busy interval from the device calendar. Mirrors `BusyBlockSchema` in `b4m-core/common/src/schemas/brief.ts`:
 * only the times leave the device, never a title, attendee or calendar. Twin of apps/ios B4MKit BusyBlocks.
 */
data class BusyBlock(val start: Instant, val end: Instant)

/** The server's view of busy-block briefs: the opt-in and the blocks it kept after merging overlaps. */
data class BusyBlocksState(val enabled: Boolean, val blocks: List<BusyBlock>, val nextBlockBriefAt: Instant? = null)

/** A calendar event as the reader sees it, before filtering down to busy blocks. */
data class CalendarEventSample(val start: Instant, val end: Instant, val isAllDay: Boolean, val availability: Availability) {
    enum class Availability { BUSY, TENTATIVE, UNAVAILABLE, FREE, NOT_SUPPORTED }
}

object BusyBlockFilter {
    // Server limits from BUSY_BLOCK_LIMITS in b4m-core/common/src/schemas/brief.ts; keep in sync.
    const val MAX_BLOCKS = 48
    val MAX_DURATION: Duration = Duration.ofHours(12)

    /** How far back and ahead the device calendar is read on each sync. */
    val LOOK_BEHIND: Duration = Duration.ofHours(1)
    val LOOK_AHEAD: Duration = Duration.ofHours(48)

    /**
     * All-day and free events are not busy time. A block longer than the server allows is dropped rather than
     * clipped, since a clipped end would trigger a brief while the user is still busy.
     */
    fun blocks(events: List<CalendarEventSample>): List<BusyBlock> =
        events
            .asSequence()
            .filter { !it.isAllDay && it.availability != CalendarEventSample.Availability.FREE }
            .filter { it.end > it.start && Duration.between(it.start, it.end) <= MAX_DURATION }
            .map { BusyBlock(it.start, it.end) }
            .sortedWith(compareBy<BusyBlock>({ it.end }, { it.start }))
            .take(MAX_BLOCKS)
            .toList()
}
