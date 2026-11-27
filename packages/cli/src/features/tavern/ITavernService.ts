import type {
  AgentListResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  UpdateAgentRequest,
  MentionResponse,
  QuestListResponse,
  CreateQuestRequest,
  QuestResponse,
  NotebookResponse,
  GateListResponse,
  GateResolveResponse,
  HeartbeatToggleResponse,
  TriggerHeartbeatResponse,
} from './types.js';

/**
 * Domain-specific service contract for Tavern operations.
 *
 * Separate from ICliFeatureModule - this is the Tavern-specific
 * abstraction that tool adapters depend on.
 */
export interface ITavernService {
  /** List all agents accessible to the current user (with IDs, names, descriptions) */
  listAgents(): Promise<AgentListResponse>;

  /** Create a new agent */
  createAgent(request: CreateAgentRequest): Promise<CreateAgentResponse>;

  /** Update an existing agent (partial update) */
  updateAgent(agentId: string, request: UpdateAgentRequest): Promise<CreateAgentResponse>;

  /** Delete an agent (soft delete) */
  deleteAgent(agentId: string): Promise<void>;

  /** Send a directed message to a specific agent, or broadcast ambient if no agentName */
  mentionAgent(
    agentName: string | undefined,
    message: string,
    config?: Record<string, unknown>
  ): Promise<MentionResponse>;

  /** List all quests on the quest board */
  listQuests(): Promise<QuestListResponse>;

  /** Post a new quest to the quest board */
  postQuest(request: CreateQuestRequest): Promise<QuestResponse>;

  /** Delete a quest from the quest board */
  deleteQuest(questId: string): Promise<void>;

  /** Read an agent's notebook/activity history */
  getAgentNotebook(agentId: string, limit?: number): Promise<NotebookResponse>;

  /** List all active (pending) confidence gates */
  listGates(): Promise<GateListResponse>;

  /** Approve or reject a confidence gate */
  resolveGate(gateId: string, resolution: 'approve' | 'reject'): Promise<GateResolveResponse>;

  /** Enable or disable background heartbeats for all agents */
  toggleHeartbeats(enabled: boolean): Promise<HeartbeatToggleResponse>;

  /** Manually trigger a heartbeat for all agents (debug/development) */
  triggerHeartbeat(config?: Record<string, unknown>): Promise<TriggerHeartbeatResponse>;

  /** Abort all in-flight heartbeats */
  abortHeartbeats(): Promise<void>;
}
