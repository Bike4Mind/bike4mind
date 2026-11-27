package com.bike4mind.kit.media

import com.bike4mind.kit.networking.ApiException
import java.io.IOException
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MediaItemTest {
    private val now = Instant.parse("2026-11-20T10:00:00Z")
    private val margin = MediaItem.EXPIRY_MARGIN.seconds

    private fun expiring(at: Instant?, url: String? = "https://u/a") = mediaItem("a").copy(url = url, urlExpiresAt = at)

    @Test
    fun aUrlIsUsableOnlyBeyondTheExpiryMargin() {
        assertTrue(expiring(now.plusSeconds(margin + 1)).isUrlUsable(now))
        assertFalse(expiring(now.plusSeconds(margin)).isUrlUsable(now))
        assertFalse(expiring(now.minusSeconds(1)).isUrlUsable(now))
    }

    @Test
    fun aUrlWithNoKnownExpiryIsTrustedAndNoUrlIsNot() {
        assertTrue(expiring(null).isUrlUsable(now))
        assertFalse(expiring(now.plusSeconds(3_600), url = null).isUrlUsable(now))
    }

    @Test
    fun theTitleDropsOnlyTheExtension() {
        assertEquals("sunset.v2", mediaItem("a").copy(fileName = "sunset.v2.png").displayTitle)
        assertEquals("noext", mediaItem("a").copy(fileName = "noext").displayTitle)
        assertNull(mediaItem("a").copy(fileName = ".png").displayTitle)
    }
}

class MediaErrorTest {
    @Test
    fun mapsFailuresToWhatTheScreenSays() {
        assertEquals(MediaError.NotFound, MediaError.from(ApiException(404)))
        assertEquals(MediaError.RateLimited, MediaError.from(ApiException(429)))
        assertEquals(MediaError.Server(503), MediaError.from(ApiException(503)))
        assertEquals(MediaError.Unreadable, MediaError.from(MalformedMediaException()))
        assertEquals(MediaError.Offline, MediaError.from(IOException("offline")))
    }

    @Test
    fun onlyAMissingOrUnreadableFileIsNotWorthRetrying() {
        assertFalse(MediaError.NotFound.isRetryable)
        assertFalse(MediaError.Unreadable.isRetryable)
        listOf(MediaError.Offline, MediaError.RateLimited, MediaError.Unplayable, MediaError.Server(500)).forEach {
            assertTrue(it.isRetryable, "$it")
        }
    }
}
