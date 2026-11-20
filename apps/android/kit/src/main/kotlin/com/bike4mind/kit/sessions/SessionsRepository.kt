package com.bike4mind.kit.sessions

import com.bike4mind.client.apis.AIApi
import com.bike4mind.client.apis.SessionsApi
import com.bike4mind.kit.networking.requireBody

/** Sessions ("notebooks" in the product UI) and their transcripts, mapped from the generated client. */
class SessionsRepository(private val sessions: SessionsApi, private val ai: AIApi) {
    suspend fun list(cursor: String? = null, limit: Int = 25): SessionPage {
        val page = sessions.listSessions(limit = limit, cursor = cursor).requireBody()
        return SessionPage(
            sessions = page.`data`.map {
                SessionSummary(it.id, it.name.ifBlank { "Untitled" }, it.lastUsedModel, it.lastUpdated)
            },
            nextCursor = page.nextCursor,
        )
    }

    /** The transcript, oldest first. */
    suspend fun quests(sessionId: String, limit: Int = 50): List<Quest> =
        sessions.listSessionQuests(sessionId, limit = limit).requireBody().`data`.sortedBy { it.createdAt }.map {
            Quest(
                id = it.id,
                sessionId = sessionId,
                prompt = it.prompt,
                reply = it.reply?.takeIf(String::isNotEmpty),
                status = QuestStatus.from(it.status),
                type = it.type,
                errorCode = it.errorCode,
            )
        }

    suspend fun quest(id: String): Quest {
        val quest = ai.getQuest(id).requireBody()
        return Quest(
            id = quest.id,
            sessionId = quest.sessionId,
            prompt = null,
            reply = Quest.replyText(quest.reply, quest.replies),
            status = QuestStatus.from(quest.status),
            type = quest.type,
            errorCode = quest.errorCode,
        )
    }
}
