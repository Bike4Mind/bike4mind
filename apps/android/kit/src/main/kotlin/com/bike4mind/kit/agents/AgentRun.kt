package com.bike4mind.kit.agents

/** The server's acknowledgement of a started agent run (`202` from `POST /api/v1/agent-executions`). */
data class AgentRunReceipt(
    val executionId: String,
    /** The chat-history quest holding the prompt. Written best effort by the server, so it can be absent. */
    val questId: String?,
    val sessionId: String,
) {
    /** What the run's notification is keyed by: the quest, or the execution when there is none. */
    val trackingId: String get() = questId ?: executionId
}

/** A run as `GET /api/v1/agent-executions/{id}` reports it. Twin of apps/ios B4MKit AgentRunStatus. */
data class AgentRunStatus(
    val id: String,
    val state: State,
    val steps: List<Step> = emptyList(),
    /** Why a `failed` run ended without an answer. */
    val error: String? = null,
    /** ReAct iterations so far (`total_iterations`); null before the first one. */
    val iterations: Int? = null,
    /** `step_progress`: null when the server cannot predict a total for this run, which is the usual case. */
    val stepProgress: StepProgress? = null,
) {
    /** The public status set (`PUBLIC_AGENT_EXECUTION_STATUSES`). */
    enum class State(val wire: String) {
        PENDING("pending"),
        RUNNING("running"),
        CONTINUING("continuing"),
        PAUSED("paused"),
        COMPLETED("completed"),
        FAILED("failed"),
        ABORTED("aborted"),
        AWAITING_PERMISSION("awaiting_permission"),
        AWAITING_SUBAGENT("awaiting_subagent"),
        AWAITING_DAG_CHILDREN("awaiting_dag_children"),
        ;

        val isTerminal: Boolean get() = this == COMPLETED || this == FAILED || this == ABORTED

        companion object {
            /** A value this build does not know reads as [RUNNING], so a newer server never ends a run early. */
            fun from(wire: String): State = entries.firstOrNull { it.wire == wire } ?: RUNNING
        }
    }

    data class Step(val kind: Kind, val toolName: String? = null) {
        enum class Kind { THOUGHT, ACTION, OBSERVATION, FINAL_ANSWER, OTHER }
    }
}

/**
 * How far a run is through a known number of steps. These are not ReAct iterations, so never pair [total] with
 * [AgentRunStatus.iterations].
 */
data class StepProgress(val completed: Int, val total: Int) {
    companion object {
        /** Null for a shape no display can draw (no total, negative count); a count past the total is capped. */
        fun of(completed: Int?, total: Int?): StepProgress? {
            if (completed == null || total == null || total <= 0 || completed < 0) return null
            return StepProgress(minOf(completed, total), total)
        }
    }
}

/** The agent-run routes. Nothing streams back over REST, so progress comes from polling [run]. */
interface AgentRunApi {
    suspend fun start(sessionId: String, message: String): AgentRunReceipt

    suspend fun run(id: String): AgentRunStatus
}
