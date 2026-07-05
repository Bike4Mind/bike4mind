import type { ToolDefinition } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { enrollMissionForAgent, findAgentsByName, formatMissionStatusReport, listMissionsForAgent } from './missions';
import { MongoDeepAgentStore } from './store';
import { runMissionFirstWake } from './firstWake';

/**
 * Chat-native missions - injected as externalTools into the agent executor so
 * "@Cerebo please draft marketing content weekly" works in conversation.
 *
 * The model passes the agent's NAME (it knows who it is - its system prompt
 * says so), and we resolve name -> agent among the caller's own agents. This
 * also means a user can say "create a mission for Cerebo to ..." in any chat.
 *
 * The first wake runs inline think-only (orient + reflect, ~10-20s) so the
 * mission is born alive and its mission-log session materializes immediately;
 * tool-enabled wakes follow via the dossier or the scheduler.
 */

interface CreateMissionParams {
  agentName: string;
  goal: string;
}

interface MissionStatusParams {
  agentName: string;
}

const logger = new Logger({ metadata: { component: 'deepAgent.missionChatTools' } });

/** Cap the inline think-only first wake (two structured steps) so a chat tool
 *  call can't starve the parent agent-executor runtime. */
const CHAT_FIRST_WAKE_STEP_TIMEOUT_MS = 20_000;

/**
 * Resolve an agent name to a single agent among the caller's own agents.
 * Agent names are not unique per user, so a multi-match is reported back to the
 * model rather than silently picking one - a wrong agent is worse than a retry.
 */
type ResolvedAgent = Awaited<ReturnType<typeof findAgentsByName>>[number];
type AgentResolution = { agent: ResolvedAgent } | { error: string };
async function resolveAgentByName(callerUserId: string, agentName: string): Promise<AgentResolution> {
  const matches = await findAgentsByName(callerUserId, agentName);
  if (matches.length === 0) {
    return { error: `No agent named "${agentName}" found among your agents. Check the name on your /agents page.` };
  }
  if (matches.length > 1) {
    return {
      error: `You have ${matches.length} agents named "${agentName}". Rename one or open /agents so we don't act on the wrong one.`,
    };
  }
  return { agent: matches[0] };
}

export const missionChatTools: Record<string, ToolDefinition> = {
  create_mission: {
    name: 'create_mission',
    implementation: context => ({
      toolFn: async value => {
        const params = value as CreateMissionParams;
        if (!params?.agentName || !params?.goal) {
          throw new Error('create_mission: agentName and goal are required');
        }
        const resolved = await resolveAgentByName(context.userId, params.agentName);
        if ('error' in resolved) return resolved.error;
        const { agent } = resolved;
        const store = new MongoDeepAgentStore();
        const { missionId } = await enrollMissionForAgent(
          { b4mAgentId: agent.id, callerUserId: context.userId, goal: params.goal },
          store
        );
        const outcome = await runMissionFirstWake(missionId, {
          logger,
          timeoutMs: CHAT_FIRST_WAKE_STEP_TIMEOUT_MS,
          userId: context.userId,
        });
        return [
          `🚀 Mission launched for **${agent.name}**.`,
          '',
          `**Goal:** ${params.goal}`,
          `**First wake:** ${outcome.handoff.lastActionSummary}`,
          `**Next:** ${outcome.handoff.nextIntendedAction}`,
          '',
          `Dossier: /agents/${agent.id}/missions/${missionId} — wake summaries and deliverables will land in the "${agent.name} — Mission" session.`,
        ].join('\n');
      },
      toolSchema: {
        name: 'create_mission',
        description:
          'Give one of the user\'s B4M agents a Mission: a standing long-horizon goal it pursues autonomously across wakes, with its own memory, drives, and adversarial-review trail. Use when the user asks an agent (or asks you, if you are their agent) to do something ongoing/recurring — e.g. "draft marketing content weekly", "track competitor X". Pass YOUR OWN name as agentName if the user is addressing you.',
        parameters: {
          type: 'object',
          properties: {
            agentName: {
              type: 'string',
              description: "The B4M agent's display name (e.g. 'Cerebo'). Use your own name if the user addressed you.",
            },
            goal: {
              type: 'string',
              description:
                'The standing goal, phrased per-wake where possible (e.g. "Each wake, draft one short piece of marketing copy and record the angle tried as memory.").',
            },
          },
          required: ['agentName', 'goal'],
        },
      },
    }),
  },
  mission_status: {
    name: 'mission_status',
    implementation: context => ({
      toolFn: async value => {
        const params = value as MissionStatusParams;
        if (!params?.agentName) throw new Error('mission_status: agentName is required');
        const resolved = await resolveAgentByName(context.userId, params.agentName);
        if ('error' in resolved) return resolved.error;
        const { agent } = resolved;
        const missions = await listMissionsForAgent(agent.id);
        return formatMissionStatusReport(agent.name, missions);
      },
      toolSchema: {
        name: 'mission_status',
        description:
          "Report the status of a B4M agent's Missions (standing autonomous goals): wakes, memories, evidence tier, blockers, next intended action. Pass your own name if the user is asking about you.",
        parameters: {
          type: 'object',
          properties: {
            agentName: { type: 'string', description: "The B4M agent's display name." },
          },
          required: ['agentName'],
        },
      },
    }),
  },
};

/** Tool names to append to enabledTools wherever missionChatTools are injected. */
export const MISSION_CHAT_TOOL_NAMES = Object.keys(missionChatTools);
