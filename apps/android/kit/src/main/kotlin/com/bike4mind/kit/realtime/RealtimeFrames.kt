package com.bike4mind.kit.realtime

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.sessions.Quest
import com.bike4mind.kit.sessions.QuestStatus
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** The realtime frames the chat round trip needs. Everything else on the socket is ignored. */
object RealtimeFrames {
    const val STREAMED_CHAT_COMPLETION = "streamed_chat_completion"
    const val HEARTBEAT = """{"action":"heartbeat"}"""

    /** One `streamed_chat_completion`: the quest's latest snapshot, sent per user (filter by session or quest). */
    data class StreamedCompletion(val quest: Quest, val statusMessage: String?)

    /**
     * Parses one text frame. Chunk pieces go through [reassembler]; `pong`, non-JSON text and unknown actions
     * return null without failing, so the socket stays up.
     */
    fun parse(text: String, reassembler: ChunkReassembler): StreamedCompletion? {
        val frame = runCatching { B4MClientJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
        if (frame.bool("_chunked") == true) {
            val chunk = ChunkReassembler.Chunk(
                chunkId = frame.string("_chunkId") ?: return null,
                index = frame.int("_chunkIndex") ?: return null,
                total = frame.int("_totalChunks") ?: return null,
                data = frame.string("_data") ?: return null,
            )
            return reassembler.accept(chunk)?.let { parse(it, reassembler) }
        }
        if (frame.string("action") != STREAMED_CHAT_COMPLETION) return null
        val quest = frame["quest"] as? JsonObject ?: return null
        val id = quest.string("id") ?: quest.string("_id") ?: return null
        return StreamedCompletion(
            quest = Quest(
                id = id,
                sessionId = quest.string("sessionId"),
                prompt = quest.string("prompt"),
                reply = Quest.replyText(quest.string("reply"), (quest["replies"] as? JsonArray)?.mapNotNull { it.stringOrNull() }),
                status = QuestStatus.from(quest.string("status")),
                type = quest.string("type"),
                errorCode = quest.string("errorCode"),
            ),
            statusMessage = frame.string("statusMessage")?.ifEmpty { null },
        )
    }

    private fun JsonElement.stringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun JsonObject.string(key: String): String? = this[key]?.stringOrNull()

    private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

    private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
}
