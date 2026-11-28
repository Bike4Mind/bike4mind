package com.bike4mind.kit.realtime

import com.bike4mind.kit.sessions.PendingActionConnector
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
    fun parsesAPendingAction() {
        val parked = """{"action":"streamed_chat_completion","quest":{"id":"q1","sessionId":"s1","status":"running",""" +
            """"pendingAction":{"tool":"web_search","params":{"query":"weather","limit":3,"site":null},"ts":1700000000123}}}"""
        val action = RealtimeFrames.parse(parked, ChunkReassembler())!!.quest.pendingAction!!
        assertEquals("web_search", action.tool)
        assertEquals(mapOf("query" to "weather", "limit" to "3", "site" to ""), action.params)
        assertEquals(1_700_000_000_123, action.requestedAtMs)
    }

    @Test
    fun parsesACustomConnectorTarget() {
        val parked = """{"action":"streamed_chat_completion","quest":{"id":"q1","status":"running",""" +
            """"pendingAction":{"tool":"create","params":{},"ts":1,""" +
            """"customConnector":{"connectionId":"c1","slug":"acme","displayName":"Acme","urlHost":"mcp.acme.test"}}}}"""
        val action = RealtimeFrames.parse(parked, ChunkReassembler())!!.quest.pendingAction!!
        assertEquals(PendingActionConnector("Acme", "mcp.acme.test"), action.connector)
    }

    @Test
    fun aBuiltInActionHasNoConnector() {
        val parked = """{"action":"streamed_chat_completion","quest":{"id":"q1","status":"running",""" +
            """"pendingAction":{"tool":"create_issue","params":{},"ts":1,"customConnector":null}}}"""
        assertNull(RealtimeFrames.parse(parked, ChunkReassembler())!!.quest.pendingAction!!.connector)
    }

    @Test
    fun dropsACustomConnectorActionThatDoesNotNameItsHost() {
        val parked = """{"action":"streamed_chat_completion","quest":{"id":"q1","status":"running",""" +
            """"pendingAction":{"tool":"create","params":{},"ts":1,"customConnector":{"displayName":"Acme"}}}}"""
        assertNull(RealtimeFrames.parse(parked, ChunkReassembler())!!.quest.pendingAction)
    }

    @Test
    fun dropsAPendingActionWithoutATimestamp() {
        val malformed = """{"action":"streamed_chat_completion","quest":{"id":"q1","sessionId":"s1",""" +
            """"pendingAction":{"tool":"web_search","params":{}}}}"""
        assertNull(RealtimeFrames.parse(malformed, ChunkReassembler())!!.quest.pendingAction)
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
