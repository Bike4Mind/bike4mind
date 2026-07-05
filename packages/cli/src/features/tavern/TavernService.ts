import type { ApiClient } from '../../auth/ApiClient.js';
import type { ITavernService } from './ITavernService.js';
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
  QuestPlanResponse,
  QuestWorkflowResponse,
} from './types.js';

/**
 * HTTP implementation of ITavernService using the shared ApiClient.
 *
 * Each method maps to one /api/tavern/* endpoint.
 * Pure transport - no business logic.
 */
export class TavernService implements ITavernService {
  constructor(private readonly apiClient: ApiClient) {}

  async listAgents(): Promise<AgentListResponse> {
    return this.apiClient.get<AgentListResponse>('/api/agents?limit=100');
  }

  async createAgent(request: CreateAgentRequest): Promise<CreateAgentResponse> {
    return this.apiClient.post<CreateAgentResponse>('/api/agents', request);
  }

  async updateAgent(agentId: string, request: UpdateAgentRequest): Promise<CreateAgentResponse> {
    return this.apiClient.put<CreateAgentResponse>(`/api/agents/${encodeURIComponent(agentId)}`, request);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.apiClient.delete(`/api/agents/${encodeURIComponent(agentId)}`);
  }

  async mentionAgent(
    agentName: string | undefined,
    message: string,
    config?: Record<string, unknown>
  ): Promise<MentionResponse> {
    return this.apiClient.post<MentionResponse>('/api/tavern/mention', {
      agentName,
      message,
      config,
    });
  }

  async listQuests(): Promise<QuestListResponse> {
    return this.apiClient.get<QuestListResponse>('/api/tavern/quests');
  }

  async postQuest(request: CreateQuestRequest): Promise<QuestResponse> {
    return this.apiClient.post<QuestResponse>('/api/tavern/quests', request);
  }

  async deleteQuest(questId: string): Promise<void> {
    await this.apiClient.delete(`/api/tavern/quests`, { data: { questId } });
  }

  async getAgentNotebook(agentId: string, limit = 50): Promise<NotebookResponse> {
    return this.apiClient.get<NotebookResponse>(
      `/api/tavern/agent-notebook?agentId=${encodeURIComponent(agentId)}&limit=${limit}`
    );
  }

  async listGates(): Promise<GateListResponse> {
    return this.apiClient.get<GateListResponse>('/api/tavern/gates');
  }

  async resolveGate(gateId: string, resolution: 'approve' | 'reject'): Promise<GateResolveResponse> {
    return this.apiClient.post<GateResolveResponse>('/api/tavern/gate-resolve', {
      gateId,
      resolution,
    });
  }

  async toggleHeartbeats(enabled: boolean): Promise<HeartbeatToggleResponse> {
    return this.apiClient.post<HeartbeatToggleResponse>('/api/tavern/toggle-heartbeats', { enabled });
  }

  async triggerHeartbeat(config?: Record<string, unknown>): Promise<TriggerHeartbeatResponse> {
    return this.apiClient.post<TriggerHeartbeatResponse>('/api/tavern/trigger-heartbeat', { config });
  }

  async abortHeartbeats(): Promise<void> {
    await this.apiClient.post('/api/tavern/abort-heartbeats', { abort: true });
  }

  async getQuestPlan(planId: string): Promise<QuestPlanResponse> {
    return this.apiClient.get<QuestPlanResponse>(`/api/quest-master-plans/${encodeURIComponent(planId)}`);
  }

  async updateReviewGate(
    planId: string,
    questId: string,
    subQuestId: string,
    reviewStatus: 'pending' | 'approved' | 'rejected',
    reviewNote?: string
  ): Promise<QuestWorkflowResponse> {
    return this.apiClient.post<QuestWorkflowResponse>(
      `/api/quest-master-plans/${encodeURIComponent(planId)}/review-gate`,
      { questId, subQuestId, reviewStatus, reviewNote }
    );
  }

  async updateSubQuestProgress(
    planId: string,
    questId: string,
    subQuestId: string,
    updates: { status?: string; evidence?: string; timeSpent?: number }
  ): Promise<QuestWorkflowResponse> {
    return this.apiClient.post<QuestWorkflowResponse>(
      `/api/quest-master-plans/${encodeURIComponent(planId)}/subquest-progress`,
      { questId, subQuestId, ...updates }
    );
  }

  async updateHandoff(
    planId: string,
    handoff: { summary: string; nextSteps: string[]; pendingDecisions: string[]; blockers: string[] }
  ): Promise<QuestWorkflowResponse> {
    return this.apiClient.post<QuestWorkflowResponse>(
      `/api/quest-master-plans/${encodeURIComponent(planId)}/handoff`,
      handoff
    );
  }
}
