package com.bike4mind.kit.realtime

import com.bike4mind.kit.sessions.QuestStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class RealtimeFramesTest {
    private val frame =
        """{"action":"streamed_chat_completion","statusMessage":"Thinking","quest":{"_id":"q1","sessionId":"s1",""" +
            """"status":"running","type":"message","reply":null,"replies":["Hel","","lo"]}}"""

    @Test
    fun parsesAStreamedCompletion() {
        val parsed = RealtimeFrames.parse(frame, ChunkReassembler())!!
        assertEquals("q1", parsed.quest.id)
        assertEquals("s1", parsed.quest.sessionId)
        assertEquals("Hello", parsed.quest.reply)
        assertEquals(QuestStatus.RUNNING, parsed.quest.status)
        assertEquals("Thinking", parsed.statusMessage)
    }

    @Test
    fun ignoresPongNonJsonAndUnknownActions() {
        val reassembler = ChunkReassembler()
        assertNull(RealtimeFrames.parse("pong", reassembler))
        assertNull(RealtimeFrames.parse("""{"action":"data_update","data":{}}""", reassembler))
        assertNull(RealtimeFrames.parse("""{"action":"an_action_added_later"}""", reassembler))
    }

    @Test
    fun reassemblesChunkedFramesInIndexOrder() {
        val reassembler = ChunkReassembler()
        val half = frame.length / 2
        fun chunk(index: Int, data: String) =
            """{"_chunked":true,"_chunkId":"c1","_chunkIndex":$index,"_totalChunks":2,"_data":${kotlinx.serialization.json.JsonPrimitive(data)}}"""

        assertNull(RealtimeFrames.parse(chunk(1, frame.substring(half)), reassembler))
        val parsed = RealtimeFrames.parse(chunk(0, frame.substring(0, half)), reassembler)

        assertEquals("Hello", parsed?.quest?.reply)
        assertEquals(0, reassembler.pendingCount)
    }

    @Test
    fun dropsInconsistentAndExpiredPartials() {
        var clock = 0L
        val reassembler = ChunkReassembler { clock }
        assertNull(reassembler.accept(ChunkReassembler.Chunk("c1", 0, 2, "a")))
        assertNull(reassembler.accept(ChunkReassembler.Chunk("c1", 1, 3, "b")))
        assertEquals(0, reassembler.pendingCount)

        assertNull(reassembler.accept(ChunkReassembler.Chunk("c2", 0, 2, "a")))
        clock += ChunkReassembler.TTL_MS
        reassembler.purgeExpired()
        assertEquals(0, reassembler.pendingCount)
    }
}
