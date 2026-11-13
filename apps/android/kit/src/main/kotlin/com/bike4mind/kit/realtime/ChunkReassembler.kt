package com.bike4mind.kit.realtime

/**
 * Rebuilds frames the server split into `_chunked` pieces: concatenated in index order, parsed once complete.
 * A partial that cannot complete is dropped, never delivered: streamed replies are cumulative, so the next
 * complete frame carries everything the lost one did. Twin of apps/ios Realtime/ChunkReassembler.swift and the
 * web client's apps/client/app/utils/wsChunkReassembler.ts; keep the limits in step.
 */
class ChunkReassembler(private val now: () -> Long = System::currentTimeMillis) {
    data class Chunk(val chunkId: String, val index: Int, val total: Int, val data: String)

    private class Partial(val total: Int, val startedAt: Long, val parts: MutableMap<Int, String> = mutableMapOf())

    private val partials = LinkedHashMap<String, Partial>()

    val pendingCount: Int get() = partials.size

    /** The reassembled JSON text once every piece arrived, else null. */
    fun accept(chunk: Chunk): String? {
        purgeExpired()
        if (chunk.total !in 1..MAX_PARTS || chunk.index !in 0 until chunk.total) {
            partials.remove(chunk.chunkId)
            return null
        }
        val partial = partials[chunk.chunkId] ?: Partial(chunk.total, now())
        if (partial.total != chunk.total) {
            partials.remove(chunk.chunkId)
            return null
        }
        partial.parts[chunk.index] = chunk.data
        if (partial.parts.size < partial.total) {
            if (!partials.containsKey(chunk.chunkId) && partials.size >= MAX_PARTIALS) {
                partials.minByOrNull { it.value.startedAt }?.key?.let(partials::remove)
            }
            partials[chunk.chunkId] = partial
            return null
        }
        partials.remove(chunk.chunkId)
        return (0 until partial.total).joinToString("") { partial.parts.getValue(it) }
    }

    /** Releases abandoned partials; also called from the heartbeat so one is freed even if no chunk follows. */
    fun purgeExpired() {
        val cutoff = now() - TTL_MS
        partials.entries.removeAll { it.value.startedAt <= cutoff }
    }

    companion object {
        const val TTL_MS = 30_000L
        const val MAX_PARTS = 256
        const val MAX_PARTIALS = 32
    }
}
