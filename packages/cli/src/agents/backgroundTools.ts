import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { BackgroundAgentManager } from './BackgroundAgentManager.js';

/**
 * Create tools for managing background agents:
 * - check_agent_status: Check on a background agent job
 * - list_background_agents: List all background agent jobs
 * - cancel_background_agent: Cancel a running background agent
 */
export function createBackgroundAgentTools(manager: BackgroundAgentManager): ICompletionOptionTools[] {
  const checkAgentStatus: ICompletionOptionTools = {
    toolFn: async (args: unknown) => {
      const { job_id } = args as { job_id: string };
      if (!job_id) throw new Error('check_agent_status: job_id is required');

      const job = manager.getJob(job_id);
      if (!job) return `No background agent found with ID: ${job_id}`;

      switch (job.status) {
        case 'queued':
          return `Agent "${job.agentName}" is queued (waiting for a concurrency slot). Task: ${job.task}`;
        case 'running': {
          const elapsed = Math.round((Date.now() - job.startTime) / 1000);
          return `Agent "${job.agentName}" is still running (${elapsed}s elapsed). Task: ${job.task}`;
        }
        case 'completed': {
          const result = manager.getResult(job_id);
          return result?.summary || `Agent "${job.agentName}" completed but no summary available.`;
        }
        case 'failed':
          return `Agent "${job.agentName}" failed: ${job.error || 'Unknown error'}`;
        case 'cancelled':
          return `Agent "${job.agentName}" was cancelled.`;
      }
    },
    toolSchema: {
      name: 'check_agent_status',
      description:
        'Check the status and retrieve results of a background agent job. Use after spawning an agent with run_in_background: true.',
      parameters: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description: 'The job ID returned by agent_delegate when run_in_background was true',
          },
        },
        required: ['job_id'],
      },
    },
  };

  const listBackgroundAgents: ICompletionOptionTools = {
    toolFn: async () => {
      const jobs = manager.listJobs();
      if (jobs.length === 0) return 'No background agents.';

      return jobs
        .map(job => {
          const elapsed = Math.round(((job.endTime || Date.now()) - job.startTime) / 1000);
          const statusIcons: Record<string, string> = {
            queued: '🕐',
            running: '⏳',
            completed: '✅',
            failed: '❌',
            cancelled: '🚫',
          };
          const statusIcon = statusIcons[job.status] || '❓';
          return `${statusIcon} [${job.id}] ${job.agentName} (${job.status}, ${elapsed}s) - ${job.task.slice(0, 80)}`;
        })
        .join('\n');
    },
    toolSchema: {
      name: 'list_background_agents',
      description: 'List all background agent jobs with their current status.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  };

  const cancelBackgroundAgent: ICompletionOptionTools = {
    toolFn: async (args: unknown) => {
      const { job_id } = args as { job_id: string };
      if (!job_id) throw new Error('cancel_background_agent: job_id is required');

      const cancelled = manager.cancelJob(job_id);
      if (cancelled) return `Background agent ${job_id} has been cancelled.`;

      const job = manager.getJob(job_id);
      if (!job) return `No background agent found with ID: ${job_id}`;
      return `Cannot cancel agent ${job_id} - status is already "${job.status}".`;
    },
    toolSchema: {
      name: 'cancel_background_agent',
      description: 'Cancel a running background agent job.',
      parameters: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description: 'The job ID of the background agent to cancel',
          },
        },
        required: ['job_id'],
      },
    },
  };

  return [checkAgentStatus, listBackgroundAgents, cancelBackgroundAgent];
}
