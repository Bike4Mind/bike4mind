/**
 * Zod schemas and TypeScript types for the Tavern CLI integration.
 *
 * These map to the REST API shapes in apps/client/pages/api/tavern/*.
 */
import { z } from 'zod';

// Re-export the WS event type from common
export type { ITavernHeartbeatLogAction } from '@bike4mind/common';

// Shared

export const HeartbeatLogEntrySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  action: z.enum([
    'idle',
    'speech',
    'thought',
    'memory',
    'move',
    'reply',
    'post_quest',
    'claim_quest',
    'complete_quest',
    'tool_use',
    'email',
    'move_decoration',
    'gate_paused',
    'gate_timed',
    'gate_proceed',
    'yolo_override',
    'intent',
    'report',
    'credits',
  ]),
  text: z.string().optional(),
  toolOutput: z.string().optional(),
  targetAgentName: z.string().optional(),
  threadId: z.string().optional(),
  timestamp: z.string(),
  burstId: z.string().optional(),
  stepIndex: z.number().optional(),
  totalSteps: z.number().optional(),
  confidence: z.number().optional(),
  confidenceSource: z.string().optional(),
  creditsUsed: z.number().optional(),
});
export type HeartbeatLogEntry = z.infer<typeof HeartbeatLogEntrySchema>;

// POST /api/agents (create a new agent)

export const CreateAgentRequestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  personality: z
    .object({
      majorMotivation: z.string().optional(),
      minorMotivation: z.string().optional(),
      flaw: z.string().optional(),
      quirk: z.string().optional(),
      description: z.string().optional(),
      personalMission: z.string().optional(),
      activeProject: z.string().optional(),
      communicationPattern: z.string().optional(),
      humorStyle: z.string().optional(),
      backstoryElement: z.string().optional(),
      energyLevel: z.string().optional(),
      coreValues: z.string().optional(),
    })
    .optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const CreateAgentResponseSchema = z.object({
  _id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type CreateAgentResponse = z.infer<typeof CreateAgentResponseSchema>;

// PUT /api/agents/[id] (update an agent - accepts Partial<IAgent>)

/** Reuses the same personality shape as create, all fields optional */
export const UpdateAgentRequestSchema = CreateAgentRequestSchema.partial().extend({
  heartbeatConfig: z
    .object({
      enabled: z.boolean().optional(),
      intervalMinutes: z.number().optional(),
    })
    .optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

// GET /api/agents (general agent listing, not tavern-specific)

export const AgentSummarySchema = z.object({
  _id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  heartbeatConfig: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentListResponseSchema = z.object({
  data: z.array(AgentSummarySchema),
  total: z.number().optional(),
});
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

// POST /api/tavern/mention

export const MentionRequestSchema = z.object({
  agentName: z.string().optional(),
  message: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type MentionRequest = z.infer<typeof MentionRequestSchema>;

/** Directed mention response (single agent) */
export const DirectedMentionResponseSchema = z.object({
  success: z.boolean(),
  agentName: z.string(),
  agentId: z.string(),
  warning: z.string().optional(),
});

/** Ambient mention response (broadcast to all agents) */
export const AmbientMentionResponseSchema = z.object({
  success: z.boolean(),
  mode: z.literal('ambient'),
  agentCount: z.number(),
  results: z.array(
    z.object({
      agentName: z.string(),
      status: z.string(),
    })
  ),
});

export const MentionResponseSchema = z.union([DirectedMentionResponseSchema, AmbientMentionResponseSchema]);
export type MentionResponse = z.infer<typeof MentionResponseSchema>;

// GET /api/tavern/quests

export const TavernQuestSchema = z.object({
  _id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string(),
  postedBy: z.string(),
  claimedBy: z.string().optional(),
  difficulty: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type TavernQuest = z.infer<typeof TavernQuestSchema>;

export const QuestListResponseSchema = z.object({
  quests: z.array(TavernQuestSchema),
});
export type QuestListResponse = z.infer<typeof QuestListResponseSchema>;

// POST /api/tavern/quests

export const CreateQuestRequestSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  agentId: z.string(),
  agentName: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard', 'epic']).optional(),
});
export type CreateQuestRequest = z.infer<typeof CreateQuestRequestSchema>;

export const QuestResponseSchema = z.object({
  quest: TavernQuestSchema,
});
export type QuestResponse = z.infer<typeof QuestResponseSchema>;

// GET /api/tavern/agent-notebook

export const NotebookEntrySchema = z.object({
  _id: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
  createdAt: z.string().optional(),
});
export type NotebookEntry = z.infer<typeof NotebookEntrySchema>;

export const NotebookResponseSchema = z.object({
  sessionId: z.string().nullable(),
  entries: z.array(NotebookEntrySchema),
});
export type NotebookResponse = z.infer<typeof NotebookResponseSchema>;

// GET /api/tavern/gates

export const TimedGateSchema = z.object({
  gateId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  userId: z.string(),
  confidence: z.number(),
  reason: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  delayMs: z.number(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'auto_proceeded']),
  resolvedBy: z.enum(['human', 'timer']).optional(),
  resolvedAt: z.number().optional(),
  burstId: z.string(),
  iteration: z.number(),
});
export type TimedGate = z.infer<typeof TimedGateSchema>;

export const GateListResponseSchema = z.object({
  gates: z.array(TimedGateSchema),
});
export type GateListResponse = z.infer<typeof GateListResponseSchema>;

// POST /api/tavern/gate-resolve

export const GateResolveRequestSchema = z.object({
  gateId: z.string(),
  resolution: z.enum(['approve', 'reject']),
});
export type GateResolveRequest = z.infer<typeof GateResolveRequestSchema>;

export const GateResolveResponseSchema = z.object({
  success: z.boolean(),
  gate: TimedGateSchema,
});
export type GateResolveResponse = z.infer<typeof GateResolveResponseSchema>;

// POST /api/tavern/toggle-heartbeats

export const HeartbeatToggleResponseSchema = z.object({
  success: z.boolean(),
  enabled: z.boolean(),
  agentCount: z.number(),
});
export type HeartbeatToggleResponse = z.infer<typeof HeartbeatToggleResponseSchema>;

// POST /api/tavern/trigger-heartbeat

export const TriggerHeartbeatResponseSchema = z.object({
  triggered: z.number(),
  results: z.array(
    z.object({
      agentId: z.string(),
      agentName: z.string(),
      status: z.string(),
      error: z.string().optional(),
    })
  ),
});
export type TriggerHeartbeatResponse = z.infer<typeof TriggerHeartbeatResponseSchema>;

// Quest Workflow Types (quest master plan operations)

/** Sub-quest within a quest */
export const SubQuestSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['not_started', 'in_progress', 'completed', 'skipped', 'deleted']),
  questId: z.string().optional(),
  startedAt: z.number().optional(),
  evidence: z.string().optional(),
  reviewGate: z.boolean().optional(),
  reviewStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
  reviewNote: z.string().optional(),
});
export type SubQuest = z.infer<typeof SubQuestSchema>;

/** Quest containing sub-quests */
export const QuestDataSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  complexity: z.string(),
  subQuests: z.array(SubQuestSchema),
});
export type QuestData = z.infer<typeof QuestDataSchema>;

/** Handoff state for session continuity */
export const HandoffSchema = z.object({
  summary: z.string(),
  nextSteps: z.array(z.string()),
  pendingDecisions: z.array(z.string()),
  blockers: z.array(z.string()),
  lastUpdatedBy: z.string(),
  updatedAt: z.string(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

/** Full quest plan response from GET /api/quest-master-plans/[id] */
export const QuestPlanResponseSchema = z.object({
  _id: z.string(),
  notebookId: z.string(),
  goal: z.string(),
  quests: z.array(QuestDataSchema),
  state: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
  handoff: HandoffSchema.optional(),
  metrics: z
    .object({
      totalTimeSpent: z.number(),
      completionRate: z.number(),
      subQuestsCompleted: z.number(),
      subQuestsTotal: z.number(),
      lastProgress: z.string().optional(),
    })
    .optional(),
});
export type QuestPlanResponse = z.infer<typeof QuestPlanResponseSchema>;

/** Request to update a review gate */
export const UpdateReviewGateRequestSchema = z.object({
  planId: z.string(),
  questId: z.string(),
  subQuestId: z.string(),
  reviewStatus: z.enum(['pending', 'approved', 'rejected']),
  reviewNote: z.string().optional(),
});
export type UpdateReviewGateRequest = z.infer<typeof UpdateReviewGateRequestSchema>;

/** Request to update sub-quest progress */
export const UpdateSubQuestProgressRequestSchema = z.object({
  planId: z.string(),
  questId: z.string(),
  subQuestId: z.string(),
  status: z.enum(['not_started', 'in_progress', 'completed', 'skipped', 'deleted']).optional(),
  evidence: z.string().optional(),
  timeSpent: z.number().optional(),
});
export type UpdateSubQuestProgressRequest = z.infer<typeof UpdateSubQuestProgressRequestSchema>;

/** Request to write a handoff */
export const UpdateHandoffRequestSchema = z.object({
  planId: z.string(),
  summary: z.string(),
  nextSteps: z.array(z.string()),
  pendingDecisions: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type UpdateHandoffRequest = z.infer<typeof UpdateHandoffRequestSchema>;

/** Success response from workflow mutation endpoints */
export const QuestWorkflowResponseSchema = z.object({
  success: z.boolean(),
  plan: z.unknown().optional(),
  metrics: z
    .object({
      totalTimeSpent: z.number(),
      completionRate: z.number(),
      subQuestsCompleted: z.number(),
      subQuestsTotal: z.number(),
      lastProgress: z.string().optional(),
    })
    .optional(),
});
export type QuestWorkflowResponse = z.infer<typeof QuestWorkflowResponseSchema>;
