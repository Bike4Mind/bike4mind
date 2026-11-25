package com.bike4mind.kit.agents

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException

/** A 2xx answer this build cannot read as a run. */
class MalformedAgentRunException(cause: Throwable? = null) : Exception("The server sent an agent run this build cannot read", cause)

/**
 * Hand-written `POST /api/v1/agent-executions` (`startAgentExecution`) and `GET /api/v1/agent-executions/{id}`
 * (`getAgentExecution`); contract b4m-core/common/src/api-contract/contracts/agentExecutions.contract.ts, schemas in
 * b4m-core/common/src/schemas/agentExecution.ts. Twin of apps/ios B4MKit/Agents/AgentRunWire.swift: the app sends
 * two fields and reads a handful, so this stays out of client/operations.txt. Keep it in sync with the contract.
 */
class AgentRunWire(private val environment: ServerEnvironment, private val http: HttpClient) : AgentRunApi {
    @Serializable
    private data class StartBody(@SerialName("session_id") val sessionId: String, val message: String)

    @Serializable
    private data class Tracking(
        @SerialName("execution_id") val executionId: String? = null,
        @SerialName("quest_id") val questId: String? = null,
    )

    @Serializable
    private data class Ack(
        val id: String? = null,
        @SerialName("session_id") val sessionId: String? = null,
        @SerialName("tracking_info") val tracking: Tracking? = null,
    )

    @Serializable
    private data class WireStep(val type: String? = null, @SerialName("tool_name") val toolName: String? = null)

    @Serializable
    private data class WireStepProgress(val completed: Int? = null, val total: Int? = null)

    @Serializable
    private data class StatusBody(
        val id: String? = null,
        val status: String? = null,
        val error: String? = null,
        val steps: List<WireStep>? = null,
        @SerialName("total_iterations") val totalIterations: Int? = null,
        @SerialName("step_progress") val stepProgress: WireStepProgress? = null,
    )

    override suspend fun start(sessionId: String, message: String): AgentRunReceipt {
        val response = http.post(environment.baseUrl + "/" + PATH) {
            contentType(ContentType.Application.Json)
            setBody(B4MClientJson.encodeToString(StartBody.serializer(), StartBody(sessionId, message)))
        }
        val status = response.status.value
        if (status != 200 && status != 202) throw ApiException(status)
        val ack = decode(response, Ack.serializer())
        val executionId = ack.tracking?.executionId ?: ack.id ?: throw MalformedAgentRunException()
        return AgentRunReceipt(
            executionId = executionId,
            questId = ack.tracking?.questId?.takeIf { it.isNotEmpty() },
            sessionId = ack.sessionId ?: sessionId,
        )
    }

    override suspend fun run(id: String): AgentRunStatus {
        // The id comes from a receipt; anything that is not a plain id never reaches the URL.
        if (!Route.isValidId(id)) throw ApiException(404)
        val response = http.get(environment.baseUrl + "/" + PATH + "/" + id)
        if (response.status.value != 200) throw ApiException(response.status.value)
        val body = decode(response, StatusBody.serializer())
        val runId = body.id ?: throw MalformedAgentRunException()
        val state = body.status ?: throw MalformedAgentRunException()
        return AgentRunStatus(
            id = runId,
            state = AgentRunStatus.State.from(state),
            steps = body.steps.orEmpty().map { AgentRunStatus.Step(stepKind(it.type), it.toolName) },
            error = body.error,
            iterations = body.totalIterations,
            stepProgress = StepProgress.of(body.stepProgress?.completed, body.stepProgress?.total),
        )
    }

    private suspend fun <T> decode(response: HttpResponse, serializer: KSerializer<T>): T = try {
        B4MClientJson.decodeFromString(serializer, response.bodyAsText())
    } catch (malformed: SerializationException) {
        throw MalformedAgentRunException(malformed)
    } catch (malformed: IllegalArgumentException) {
        throw MalformedAgentRunException(malformed)
    }

    private fun stepKind(wire: String?) = when (wire) {
        "thought" -> AgentRunStatus.Step.Kind.THOUGHT
        "action" -> AgentRunStatus.Step.Kind.ACTION
        "observation" -> AgentRunStatus.Step.Kind.OBSERVATION
        "final_answer" -> AgentRunStatus.Step.Kind.FINAL_ANSWER
        else -> AgentRunStatus.Step.Kind.OTHER
    }

    private companion object {
        const val PATH = "api/v1/agent-executions"
    }
}
