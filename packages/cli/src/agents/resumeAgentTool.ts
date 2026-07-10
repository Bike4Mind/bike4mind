import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { SubagentOrchestrator, SpawnAgentOptions } from './SubagentOrchestrator.js';
import type { AgentHistoryStore } from './AgentHistoryStore.js';
import type { BackgroundAgentManager } from './BackgroundAgentManager.js';

/**
 * Create the resume_agent tool.
 *
 * Lets the orchestrator continue a previously completed sub-agent session with
 * its full conversation replayed, so a follow-up (e.g. "fix this bug") lands
 * with all the original context instead of starting a fresh agent cold.
 *
 * resume_agent is orchestrator-only - it is listed in ALWAYS_DENIED_FOR_AGENTS
 * so subagents cannot chain resumes.
 */
export function createResumeAgentTool(
  orchestrator: SubagentOrchestrator,
  historyStore: AgentHistoryStore,
  backgroundManager?: BackgroundAgentManager
): ICompletionOptionTools {
  return {
    toolFn: async (args: unknown) => {
      const { job_id, task, run_in_background } = args as {
        job_id: string;
        task: string;
        run_in_background?: boolean;
      };

      if (!job_id) throw new Error('resume_agent: job_id is required');
      if (!task) throw new Error('resume_agent: task is required');

      const stored = historyStore.get(job_id);
      if (!stored) {
        return `No resumable session found for ID "${job_id}". It may have expired (histories are retained for a limited time) or never existed. Delegate a fresh agent instead.`;
      }

      // run() prepends its own system prompt, so drop the checkpoint's leading
      // system message to avoid a duplicate system message on resume.
      const previousMessages = stored.checkpoint.messages.slice(1);

      const spawnOptions: SpawnAgentOptions = {
        task,
        agentName: stored.agentName,
        thoroughness: stored.thoroughness,
        parentSessionId: stored.parentSessionId,
        previousMessages,
      };

      if (run_in_background && backgroundManager) {
        // spawn assigns a fresh job id and keys the resumed run's history to it.
        const newJobId = backgroundManager.spawn(spawnOptions);
        return `Resumed agent "${stored.agentName}" in the background. New job ID: ${newJobId}. Use check_agent_status with this ID to retrieve results, or resume_agent again to continue.`;
      }

      // Foreground: reuse the same id so the session keeps a stable handle across resumes.
      const result = await orchestrator.delegateToAgent({ ...spawnOptions, resumeId: job_id });
      return `${result.summary}\n\n[resumed session ${result.resumeId}; call resume_agent with this id to continue it]`;
    },
    toolSchema: {
      name: 'resume_agent',
      description:
        'Resume a previously completed sub-agent session with its full context intact, giving it new instructions (e.g. to fix a bug in its earlier output). Prefer this over agent_delegate when following up on a specific prior run, so the agent keeps its original reasoning instead of starting from scratch. Sessions are retained for a limited time after they finish.',
      parameters: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description:
              'The resume id of the session to continue: the job ID from agent_delegate/check_agent_status for background runs, or the id surfaced in a foreground agent_delegate result.',
          },
          task: {
            type: 'string',
            description: 'New instructions for the resumed agent (e.g. "the fix broke the build, correct it").',
          },
          run_in_background: {
            type: 'boolean',
            description:
              'Resume in the background (non-blocking). Returns a new job ID to poll with check_agent_status. Defaults to false (blocks until the resumed run completes).',
          },
        },
        required: ['job_id', 'task'],
      },
    },
  };
}
