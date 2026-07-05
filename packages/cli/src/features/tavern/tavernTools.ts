import { z } from 'zod';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ITavernService } from './ITavernService.js';
import { CreateAgentRequestSchema, CreateQuestRequestSchema, UpdateAgentRequestSchema } from './types.js';

// Zod schemas for quest workflow tool params (snake_case, LLM-facing)

const GetQuestPlanParamsSchema = z.object({
  plan_id: z.string().min(1),
});

const UpdateReviewGateParamsSchema = z.object({
  plan_id: z.string().min(1),
  quest_id: z.string().min(1),
  sub_quest_id: z.string().min(1),
  review_status: z.enum(['pending', 'approved', 'rejected']),
  review_note: z.string().optional(),
});

const UpdateQuestProgressParamsSchema = z.object({
  plan_id: z.string().min(1),
  quest_id: z.string().min(1),
  sub_quest_id: z.string().min(1),
  status: z.enum(['not_started', 'in_progress', 'completed', 'skipped', 'deleted']).optional(),
  evidence: z.string().optional(),
  time_spent: z.number().min(0).optional(),
});

const WriteHandoffParamsSchema = z.object({
  plan_id: z.string().min(1),
  summary: z.string().min(1),
  next_steps: z.array(z.string()),
  pending_decisions: z.array(z.string()),
  blockers: z.array(z.string()),
});

/**
 * Factory that creates ICompletionOptionTools[] for the Tavern feature.
 * Each tool is a pure adapter: schema + delegation to the service.
 */
export function createTavernTools(service: ITavernService): ICompletionOptionTools[] {
  return [
    createListAgentsTool(service),
    createCreateAgentTool(service),
    createEditAgentTool(service),
    createDeleteAgentTool(service),
    createMentionTool(service),
    createListQuestsTool(service),
    createPostQuestTool(service),
    createDeleteQuestTool(service),
    createReadNotebookTool(service),
    createListGatesTool(service),
    createResolveGateTool(service),
    createToggleHeartbeatsTool(service),
    createTriggerHeartbeatTool(service),
    createAbortHeartbeatsTool(service),
    createStatusTool(service),
    createGetQuestPlanTool(service),
    createUpdateReviewGateTool(service),
    createUpdateQuestProgressTool(service),
    createWriteHandoffTool(service),
  ];
}

function createListAgentsTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_list_agents',
      description:
        'List all Tavern agents with their IDs, names, descriptions, and heartbeat status. ' +
        'Use this FIRST to discover agent IDs before using tools that require an agent_id (like tavern_read_notebook or tavern_post_quest).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    toolFn: async () => {
      const result = await service.listAgents();
      return JSON.stringify(result);
    },
  };
}

function createCreateAgentTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_create_agent',
      description:
        'Create a new Tavern agent with a personality. The agent will be created without heartbeats enabled — ' +
        'use tavern_toggle_heartbeats after creation to activate autonomous behavior. ' +
        'Personality fields shape how the agent thinks and acts during heartbeats.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The agent name (e.g. "Spock", "Luna", "Chef Gordon")',
          },
          description: {
            type: 'string',
            description: 'A short description of the agent',
          },
          system_prompt: {
            type: 'string',
            description: "System prompt that defines the agent's core behavior and knowledge",
          },
          major_motivation: {
            type: 'string',
            description: 'What primarily drives this agent (e.g. "Exploring the unknown")',
          },
          minor_motivation: {
            type: 'string',
            description: 'Secondary drive (e.g. "Collecting rare artifacts")',
          },
          flaw: {
            type: 'string',
            description: 'A character flaw that creates interesting behavior (e.g. "Overthinks simple problems")',
          },
          quirk: {
            type: 'string',
            description: 'A distinctive behavioral quirk (e.g. "Speaks in nautical metaphors")',
          },
          personality_description: {
            type: 'string',
            description: 'Overall personality summary',
          },
          personal_mission: {
            type: 'string',
            description: 'The agent\'s purpose in the tavern (e.g. "Map every corner of the digital realm")',
          },
          active_project: {
            type: 'string',
            description: 'What the agent is currently working on',
          },
          communication_pattern: {
            type: 'string',
            description: 'How the agent communicates (e.g. "Formal and precise", "Casual and witty")',
          },
          humor_style: {
            type: 'string',
            description: 'The agent\'s sense of humor (e.g. "Dry wit", "Puns and wordplay")',
          },
          backstory_element: {
            type: 'string',
            description: 'A backstory detail that influences behavior',
          },
          energy_level: {
            type: 'string',
            description: 'Default energy level (e.g. "High energy morning person", "Calm and measured")',
          },
          core_values: {
            type: 'string',
            description: 'What the agent values most (e.g. "Truth and transparency")',
          },
        },
        required: ['name'],
      },
    },
    toolFn: async (params: unknown) => {
      const raw = params as Record<string, unknown>;
      const request = CreateAgentRequestSchema.parse({
        name: raw.name,
        description: raw.description,
        systemPrompt: raw.system_prompt,
        personality: {
          majorMotivation: raw.major_motivation,
          minorMotivation: raw.minor_motivation,
          flaw: raw.flaw,
          quirk: raw.quirk,
          description: raw.personality_description,
          personalMission: raw.personal_mission,
          activeProject: raw.active_project,
          communicationPattern: raw.communication_pattern,
          humorStyle: raw.humor_style,
          backstoryElement: raw.backstory_element,
          energyLevel: raw.energy_level,
          coreValues: raw.core_values,
        },
      });
      const result = await service.createAgent(request);
      return JSON.stringify(result);
    },
  };
}

function createEditAgentTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_edit_agent',
      description:
        'Update an existing Tavern agent. Can change personality, system prompt, heartbeat config, or any other field. ' +
        'Use this to enable/disable heartbeats for a SINGLE agent (set heartbeat_enabled), or to update personality traits. ' +
        'Only provide fields you want to change — unspecified fields remain unchanged.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'The MongoDB ObjectId of the agent (get from tavern_list_agents)',
          },
          name: { type: 'string', description: 'New agent name' },
          description: { type: 'string', description: 'New description' },
          system_prompt: { type: 'string', description: 'New system prompt' },
          heartbeat_enabled: {
            type: 'boolean',
            description: 'Enable or disable heartbeats for THIS specific agent',
          },
          heartbeat_interval_minutes: {
            type: 'number',
            description: 'Heartbeat interval in minutes (default: 3)',
          },
          major_motivation: { type: 'string', description: 'What primarily drives this agent' },
          minor_motivation: { type: 'string', description: 'Secondary drive' },
          flaw: { type: 'string', description: 'Character flaw' },
          quirk: { type: 'string', description: 'Distinctive quirk' },
          personal_mission: { type: 'string', description: "Agent's purpose in the tavern" },
          active_project: { type: 'string', description: 'What the agent is currently working on' },
          communication_pattern: { type: 'string', description: 'How the agent communicates' },
          humor_style: { type: 'string', description: "Agent's sense of humor" },
        },
        required: ['agent_id'],
      },
    },
    toolFn: async (params: unknown) => {
      const raw = params as Record<string, unknown>;
      const agentId = raw.agent_id as string;

      const payload: Record<string, unknown> = {};

      if (raw.name !== undefined) payload.name = raw.name;
      if (raw.description !== undefined) payload.description = raw.description;
      if (raw.system_prompt !== undefined) payload.systemPrompt = raw.system_prompt;

      if (raw.heartbeat_enabled !== undefined || raw.heartbeat_interval_minutes !== undefined) {
        const hb: Record<string, unknown> = {};
        if (raw.heartbeat_enabled !== undefined) hb.enabled = raw.heartbeat_enabled;
        if (raw.heartbeat_interval_minutes !== undefined) hb.intervalMinutes = raw.heartbeat_interval_minutes;
        payload.heartbeatConfig = hb;
      }

      const personality: Record<string, unknown> = {};
      if (raw.major_motivation !== undefined) personality.majorMotivation = raw.major_motivation;
      if (raw.minor_motivation !== undefined) personality.minorMotivation = raw.minor_motivation;
      if (raw.flaw !== undefined) personality.flaw = raw.flaw;
      if (raw.quirk !== undefined) personality.quirk = raw.quirk;
      if (raw.personal_mission !== undefined) personality.personalMission = raw.personal_mission;
      if (raw.active_project !== undefined) personality.activeProject = raw.active_project;
      if (raw.communication_pattern !== undefined) personality.communicationPattern = raw.communication_pattern;
      if (raw.humor_style !== undefined) personality.humorStyle = raw.humor_style;
      if (Object.keys(personality).length > 0) payload.personality = personality;

      const request = UpdateAgentRequestSchema.parse(payload);
      const result = await service.updateAgent(agentId, request);
      return JSON.stringify(result);
    },
  };
}

function createDeleteAgentTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_delete_agent',
      description:
        'Permanently delete a Tavern agent. This is irreversible. ' +
        'IMPORTANT: agent_id must be a MongoDB ObjectId from tavern_list_agents.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'The MongoDB ObjectId of the agent to delete',
          },
        },
        required: ['agent_id'],
      },
    },
    toolFn: async (params: unknown) => {
      const { agent_id } = params as { agent_id: string };
      await service.deleteAgent(agent_id);
      return JSON.stringify({ success: true, message: `Agent ${agent_id} deleted` });
    },
  };
}

function createMentionTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_mention',
      description:
        'Send a message to a specific Tavern agent by name, or broadcast an ambient message to all agents if no agent_name is provided. ' +
        'Use this to talk to agents, ask them questions, give them instructions, or announce something to the whole tavern.',
      parameters: {
        type: 'object',
        properties: {
          agent_name: {
            type: 'string',
            description: 'Name of the agent to mention (omit for ambient broadcast to all agents)',
          },
          message: {
            type: 'string',
            description: 'The message to send to the agent(s)',
          },
        },
        required: ['message'],
      },
    },
    toolFn: async (params: unknown) => {
      const { agent_name, message } = params as { agent_name?: string; message: string };
      const result = await service.mentionAgent(agent_name, message);
      return JSON.stringify(result);
    },
  };
}

function createListQuestsTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_list_quests',
      description:
        'List all quests on the Tavern quest board. Shows quest title, status, who posted it, and who claimed it.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    toolFn: async () => {
      const result = await service.listQuests();
      return JSON.stringify(result);
    },
  };
}

function createPostQuestTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_post_quest',
      description: 'Post a new quest to the Tavern quest board for agents to discover and claim.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Quest title',
          },
          description: {
            type: 'string',
            description: 'Detailed quest description',
          },
          agent_id: {
            type: 'string',
            description: 'ID of the agent posting the quest',
          },
          agent_name: {
            type: 'string',
            description: 'Name of the agent posting the quest',
          },
          difficulty: {
            type: 'string',
            description: 'Quest difficulty level',
            enum: ['easy', 'medium', 'hard', 'epic'],
          },
        },
        required: ['title', 'agent_id', 'agent_name'],
      },
    },
    toolFn: async (params: unknown) => {
      const raw = params as Record<string, unknown>;
      const request = CreateQuestRequestSchema.parse({
        title: raw.title,
        description: raw.description,
        agentId: raw.agent_id,
        agentName: raw.agent_name,
        difficulty: raw.difficulty,
      });
      const result = await service.postQuest(request);
      return JSON.stringify(result);
    },
  };
}

function createDeleteQuestTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_delete_quest',
      description: 'Remove a quest from the Tavern quest board by its ID.',
      parameters: {
        type: 'object',
        properties: {
          quest_id: {
            type: 'string',
            description: 'The ID of the quest to delete',
          },
        },
        required: ['quest_id'],
      },
    },
    toolFn: async (params: unknown) => {
      const { quest_id } = params as { quest_id: string };
      await service.deleteQuest(quest_id);
      return JSON.stringify({ success: true });
    },
  };
}

function createReadNotebookTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_read_notebook',
      description:
        "Read a Tavern agent's activity notebook/history. Shows their recent actions, thoughts, conversations, and quest progress. " +
        'IMPORTANT: agent_id must be a MongoDB ObjectId (e.g. "6540b58d1f703ade3ea1e82b"), NOT the agent name. ' +
        'Use tavern_list_agents first to get the correct ID.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'The MongoDB ObjectId of the agent (get this from tavern_list_agents, NOT the agent name)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of entries to return (default: 50)',
          },
        },
        required: ['agent_id'],
      },
    },
    toolFn: async (params: unknown) => {
      const { agent_id, limit } = params as { agent_id: string; limit?: number };
      const result = await service.getAgentNotebook(agent_id, limit);
      return JSON.stringify(result);
    },
  };
}

function createListGatesTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_list_gates',
      description:
        'List all pending confidence gates in the Tavern. Gates are pause points where agents need human approval to proceed with low-confidence actions.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    toolFn: async () => {
      const result = await service.listGates();
      return JSON.stringify(result);
    },
  };
}

function createResolveGateTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_resolve_gate',
      description:
        'Approve or reject a pending confidence gate. This lets an agent proceed or stops its current action.',
      parameters: {
        type: 'object',
        properties: {
          gate_id: {
            type: 'string',
            description: 'The ID of the gate to resolve',
          },
          resolution: {
            type: 'string',
            description: 'Whether to approve or reject the gate',
            enum: ['approve', 'reject'],
          },
        },
        required: ['gate_id', 'resolution'],
      },
    },
    toolFn: async (params: unknown) => {
      const { gate_id, resolution } = params as { gate_id: string; resolution: 'approve' | 'reject' };
      const result = await service.resolveGate(gate_id, resolution);
      return JSON.stringify(result);
    },
  };
}

function createToggleHeartbeatsTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_toggle_heartbeats',
      description:
        'Enable or disable background heartbeats for all Tavern agents. When enabled, agents autonomously think, act, and interact on a schedule.',
      parameters: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'true to enable heartbeats, false to disable',
          },
        },
        required: ['enabled'],
      },
    },
    toolFn: async (params: unknown) => {
      const { enabled } = params as { enabled: boolean };
      const result = await service.toggleHeartbeats(enabled);
      return JSON.stringify(result);
    },
  };
}

function createTriggerHeartbeatTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_trigger_heartbeat',
      description:
        'Manually trigger a heartbeat cycle for all Tavern agents. Useful for testing or forcing immediate agent activity.',
      parameters: {
        type: 'object',
        properties: {
          config: {
            type: 'object',
            description:
              'Optional configuration overrides for the heartbeat. Known keys: ' +
              'preferredModelId (string — model ID to use), ' +
              'costMode ("low" | "normal" | "high")',
            additionalProperties: true,
          },
        },
      },
    },
    toolFn: async (params: unknown) => {
      const { config } = (params ?? {}) as { config?: Record<string, unknown> };
      const result = await service.triggerHeartbeat(config);
      return JSON.stringify(result);
    },
  };
}

function createAbortHeartbeatsTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_abort_heartbeats',
      description: 'Emergency stop — abort all in-flight Tavern agent heartbeats immediately.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    toolFn: async () => {
      await service.abortHeartbeats();
      return JSON.stringify({ success: true, message: 'All in-flight heartbeats aborted' });
    },
  };
}

function createStatusTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_status',
      description:
        'Get a quick overview of the Tavern: agent count, heartbeat status, active quests, and pending gates. ' +
        'Use this for situational awareness before taking action.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    toolFn: async () => {
      const [agents, quests, gates] = await Promise.all([
        service.listAgents(),
        service.listQuests(),
        service.listGates(),
      ]);

      const agentList = agents.data ?? [];
      const heartbeatEnabled = agentList.filter(a => a.heartbeatConfig?.enabled);

      return JSON.stringify({
        agents: {
          total: agentList.length,
          withHeartbeats: heartbeatEnabled.length,
          names: agentList.map(a => ({ name: a.name, heartbeat: a.heartbeatConfig?.enabled ?? false })),
        },
        quests: {
          total: quests.quests.length,
          byStatus: quests.quests.reduce(
            (acc, q) => {
              acc[q.status] = (acc[q.status] ?? 0) + 1;
              return acc;
            },
            {} as Record<string, number>
          ),
        },
        gates: {
          pending: gates.gates.length,
        },
      });
    },
  };
}

function createGetQuestPlanTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_get_quest_plan',
      description:
        'Fetch a quest master plan by ID. Returns the full plan with all quests, sub-quests, review gate status, ' +
        'handoff state, and progress metrics. Use this to check which sub-quests have review gates and their current status.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: {
            type: 'string',
            description: 'The MongoDB ObjectId of the quest master plan',
          },
        },
        required: ['plan_id'],
      },
    },
    toolFn: async (params: unknown) => {
      const { plan_id } = GetQuestPlanParamsSchema.parse(params);
      const result = await service.getQuestPlan(plan_id);
      return JSON.stringify(result);
    },
  };
}

function createUpdateReviewGateTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_update_review_gate',
      description:
        'Approve or reject a review gate on a sub-quest. Review gates are human approval checkpoints — ' +
        'when a sub-quest has reviewGate: true, the AI must stop and wait for human approval before proceeding.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: {
            type: 'string',
            description: 'The MongoDB ObjectId of the quest master plan',
          },
          quest_id: {
            type: 'string',
            description: 'The ID of the parent quest',
          },
          sub_quest_id: {
            type: 'string',
            description: 'The ID of the sub-quest with the review gate',
          },
          review_status: {
            type: 'string',
            description: 'The review decision',
            enum: ['pending', 'approved', 'rejected'],
          },
          review_note: {
            type: 'string',
            description: 'Optional note explaining the review decision',
          },
        },
        required: ['plan_id', 'quest_id', 'sub_quest_id', 'review_status'],
      },
    },
    toolFn: async (params: unknown) => {
      const { plan_id, quest_id, sub_quest_id, review_status, review_note } =
        UpdateReviewGateParamsSchema.parse(params);
      const result = await service.updateReviewGate(plan_id, quest_id, sub_quest_id, review_status, review_note);
      return JSON.stringify(result);
    },
  };
}

function createUpdateQuestProgressTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_update_quest_progress',
      description:
        "Update a sub-quest's progress. Set status to track completion, add evidence of what was accomplished, " +
        'and optionally record time spent. Setting status to "in_progress" auto-resumes a paused plan.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: {
            type: 'string',
            description: 'The MongoDB ObjectId of the quest master plan',
          },
          quest_id: {
            type: 'string',
            description: 'The ID of the parent quest',
          },
          sub_quest_id: {
            type: 'string',
            description: 'The ID of the sub-quest to update',
          },
          status: {
            type: 'string',
            description: 'New status for the sub-quest',
            enum: ['not_started', 'in_progress', 'completed', 'skipped', 'deleted'],
          },
          evidence: {
            type: 'string',
            description:
              'Evidence of completion — links to artifacts, descriptions of output, or references to results',
          },
          time_spent: {
            type: 'number',
            description: 'Time spent on this sub-quest in milliseconds',
          },
        },
        required: ['plan_id', 'quest_id', 'sub_quest_id'],
      },
    },
    toolFn: async (params: unknown) => {
      const { plan_id, quest_id, sub_quest_id, status, evidence, time_spent } =
        UpdateQuestProgressParamsSchema.parse(params);
      const updates: { status?: string; evidence?: string; timeSpent?: number } = {};
      if (status !== undefined) updates.status = status;
      if (evidence !== undefined) updates.evidence = evidence;
      if (time_spent !== undefined) updates.timeSpent = time_spent;

      const result = await service.updateSubQuestProgress(plan_id, quest_id, sub_quest_id, updates);
      return JSON.stringify(result);
    },
  };
}

function createWriteHandoffTool(service: ITavernService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'tavern_write_handoff',
      description:
        'Write a handoff state for session continuity. Called when ending a session so the next session can ' +
        'resume with full context. Includes a summary of progress, next steps, pending decisions, and blockers.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: {
            type: 'string',
            description: 'The MongoDB ObjectId of the quest master plan',
          },
          summary: {
            type: 'string',
            description: 'Summary of what was accomplished in this session',
          },
          next_steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of next steps for the following session',
          },
          pending_decisions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Decisions that still need to be made',
          },
          blockers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Current blockers preventing progress',
          },
        },
        required: ['plan_id', 'summary', 'next_steps', 'pending_decisions', 'blockers'],
      },
    },
    toolFn: async (params: unknown) => {
      const { plan_id, summary, next_steps, pending_decisions, blockers } = WriteHandoffParamsSchema.parse(params);
      const result = await service.updateHandoff(plan_id, {
        summary,
        nextSteps: next_steps,
        pendingDecisions: pending_decisions,
        blockers,
      });
      return JSON.stringify(result);
    },
  };
}
