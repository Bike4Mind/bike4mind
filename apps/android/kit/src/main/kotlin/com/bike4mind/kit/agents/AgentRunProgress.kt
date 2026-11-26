package com.bike4mind.kit.agents

/** Where a run stands as its notification shows it. Same phases as the iOS Live Activity (`QuestRunPhase`). */
enum class AgentRunPhase {
    RUNNING,
    PAUSED,
    APPROVAL_NEEDED,
    COMPLETED,
    FAILED,
    STOPPED,
    ;

    val isTerminal: Boolean get() = this == COMPLETED || this == FAILED || this == STOPPED

    /** The run is blocked on the user: the ongoing notification gives way to one that asks for them. */
    val needsUser: Boolean get() = this == PAUSED || this == APPROVAL_NEEDED
}

data class AgentRunProgress(
    val phase: AgentRunPhase,
    val stageLabel: String? = null,
    /** ReAct iterations so far: a count, not a fraction, since iterations have no total. */
    val iterations: Int? = null,
    /** Present only when the server knows the run's step total; draw determinate progress from this alone. */
    val steps: StepProgress? = null,
) {
    companion object {
        const val STARTING_LABEL = "Starting agent"
        const val APPROVAL_LABEL = "Waiting for your approval"
        const val PAUSED_LABEL = "Waiting for your input"
        const val MAX_STAGE_LABEL_LENGTH = 60

        val starting = AgentRunProgress(AgentRunPhase.RUNNING, STARTING_LABEL)

        /**
         * Twin of apps/ios QuestActivityMapping.state(from: AgentRunStatus), which mirrors the server's own mapping
         * (apps/workers/src/queueHandlers/agentExecutor.push.ts) so the phone and the lock-screen pushes agree.
         */
        fun from(run: AgentRunStatus): AgentRunProgress {
            val iterations = run.iterations?.takeIf { it > 0 }
            return phaseAndLabel(run, iterations).copy(steps = run.stepProgress)
        }

        private fun phaseAndLabel(run: AgentRunStatus, iterations: Int?): AgentRunProgress =
            when (run.state) {
                AgentRunStatus.State.COMPLETED -> AgentRunProgress(AgentRunPhase.COMPLETED, iterations = iterations)
                AgentRunStatus.State.FAILED -> AgentRunProgress(AgentRunPhase.FAILED, stageLabel(run.error), iterations)
                AgentRunStatus.State.ABORTED -> AgentRunProgress(AgentRunPhase.STOPPED, iterations = iterations)
                AgentRunStatus.State.AWAITING_PERMISSION -> AgentRunProgress(AgentRunPhase.APPROVAL_NEEDED, APPROVAL_LABEL, iterations)
                AgentRunStatus.State.PAUSED -> AgentRunProgress(AgentRunPhase.PAUSED, PAUSED_LABEL, iterations)
                AgentRunStatus.State.PENDING,
                AgentRunStatus.State.RUNNING,
                AgentRunStatus.State.CONTINUING,
                AgentRunStatus.State.AWAITING_SUBAGENT,
                AgentRunStatus.State.AWAITING_DAG_CHILDREN,
                -> AgentRunProgress(AgentRunPhase.RUNNING, stageLabel(run.steps), iterations)
            }

        /** "Using <tool>" while a tool runs, "Finished <tool>" once its observation arrives. */
        private fun stageLabel(steps: List<AgentRunStatus.Step>): String? {
            var lastTool: String? = null
            var label: String? = null
            for (step in steps) {
                when (step.kind) {
                    AgentRunStatus.Step.Kind.ACTION -> {
                        val tool = step.toolName?.takeIf { it.isNotEmpty() } ?: continue
                        lastTool = tool
                        label = "Using $tool"
                    }
                    AgentRunStatus.Step.Kind.OBSERVATION -> lastTool?.let { label = "Finished $it" }
                    else -> Unit
                }
            }
            return stageLabel(label)
        }

        /** Trimmed and capped (a notification line is short); blank is no label. */
        fun stageLabel(text: String?): String? {
            val trimmed = text?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            if (trimmed.length <= MAX_STAGE_LABEL_LENGTH) return trimmed
            return trimmed.take(MAX_STAGE_LABEL_LENGTH - 3) + "..."
        }
    }
}

/** Twin of apps/ios QuestActivityTitle: a notification title for a run, from the opening of what was asked. */
object AgentRunTitle {
    const val MAX_LENGTH = 40

    fun fromPrompt(prompt: String): String {
        val collapsed = prompt.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        if (collapsed.isEmpty()) return "Bike4Mind"
        if (collapsed.length <= MAX_LENGTH) return collapsed
        return collapsed.take(MAX_LENGTH - 3) + "..."
    }
}
