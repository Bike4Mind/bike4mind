package com.bike4mind.kit.auth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class PendingRevocationCodecTest {
    private val now = 1_800_000_000_000L
    private val legacy = """[{"baseUrl":"https://legacy.example.test","refreshToken":"legacy"}]"""

    @Test
    fun anUndatedQueueIsPersistedOnceBeforeItIsReturned() {
        var stored = legacy
        val first = PendingRevocationCodec.load(stored, now, persist = { stored = it }, confirmPersisted = {})
        assertEquals(listOf(PendingRevocation("https://legacy.example.test", "legacy", now)), first)
        var rewrites = 0
        val second = PendingRevocationCodec.load(stored, now + 100, persist = { rewrites++ }, confirmPersisted = {})
        assertEquals(first, second)
        assertEquals(0, rewrites)
    }

    @Test
    fun aFailedMigrationDoesNotReturnOrEraseTheOriginalQueue() {
        var stored = legacy
        assertFailsWith<IllegalStateException> {
            PendingRevocationCodec.load(stored, now, persist = { error("Injected migration write failure") }, confirmPersisted = {})
        }
        assertEquals(legacy, stored)
        val retried = PendingRevocationCodec.load(stored, now + 100, persist = { stored = it }, confirmPersisted = {})
        assertEquals(now + 100, retried.single().createdAtMillis)
    }

    @Test
    fun mixedRecordsKeepTheExistingTimestampAndAgeLimit() {
        val mixed = """[{"baseUrl":"https://legacy.example.test","refreshToken":"legacy"},{"baseUrl":"https://dated.example.test","refreshToken":"dated","createdAt":0}]"""
        val loaded = PendingRevocationCodec.load(mixed, now, persist = {}, confirmPersisted = {})
        assertEquals(listOf(now, 0L), loaded.map { it.createdAtMillis })
        assertEquals(listOf(loaded.first()), PendingRevocation.bounded(loaded, now))
    }
    @Test
    fun aFailedCommitCannotBeBypassedByItsDatedMemoryCache() {
        var cached = legacy
        var persisted = legacy
        var failing = true
        fun save(encoded: String) {
            cached = encoded
            if (failing) error("Injected disk commit failure after memory update")
            persisted = encoded
        }
        fun confirmPersisted() {
            if (failing) error("Injected confirmation failure")
            persisted = cached
        }
        assertFailsWith<IllegalStateException> { PendingRevocationCodec.load(cached, now, ::save, ::confirmPersisted) }
        assertEquals(legacy, persisted)
        assertFailsWith<IllegalStateException> { PendingRevocationCodec.load(cached, now + 100, ::save, ::confirmPersisted) }
        failing = false
        val recovered = PendingRevocationCodec.load(cached, now + 200, ::save, ::confirmPersisted)
        assertEquals(now, recovered.single().createdAtMillis)
        assertEquals(cached, persisted)
    }

    @Test
    fun aFailedClearCannotExposeAnEmptyCacheBeforeDiskConfirmation() {
        val cached: String? = null
        var persisted: String? = legacy
        var failing = true
        fun load() = PendingRevocationCodec.load(
            cached,
            now,
            persist = { error("Empty queue must not be recreated") },
            confirmPersisted = {
                if (failing) error("Injected clear confirmation failure")
                persisted = cached
            },
        )
        assertFailsWith<IllegalStateException> { load() }
        assertEquals(legacy, persisted)
        failing = false
        assertEquals(emptyList(), load())
        assertEquals(null, persisted)
    }

}
