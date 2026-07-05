/**
 * Data hooks for the Deep Agent Console (`/deep-agents`).
 *
 * Read models are type-only imports from the server's consoleReads module so
 * the client and server share one compile-time-linked shape: a projection
 * tweak is a type error on both sides instead of silent drift.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentRosterItem, AgentDetail } from '@server/deepAgent/consoleReads';
import { api } from '@client/app/contexts/ApiContext';

export type { AgentRosterItem, AgentDetail };

/** The caller's agent roster, newest activity first. Polls while mounted. */
export function useDeepAgentsList() {
  return useQuery({
    queryKey: ['deep-agents'],
    queryFn: async () => {
      const { data } = await api.get<{ agents: AgentRosterItem[] }>('/api/deep-agent/agents');
      return data.agents;
    },
    refetchInterval: 30_000,
  });
}

/** Full charter + handoff + episode tail for one agent. */
export function useDeepAgentDetail(agentId: string | null) {
  return useQuery({
    queryKey: ['deep-agent', agentId],
    enabled: Boolean(agentId),
    queryFn: async () => {
      const { data } = await api.get<AgentDetail>(`/api/deep-agent/agents/${agentId}?episodes=20`);
      return data;
    },
  });
}

export interface SpinRequest {
  /** Re-wake an existing agent; omit to enroll a fresh one. */
  agentId?: string;
  name?: string;
  role?: string;
  goal?: string;
  enableTools?: boolean;
}

export interface SpinResponse {
  agentId: string;
  latency_ms: number;
}

/**
 * Enroll-and-wake (no agentId) or wake-now (agentId). A wake is a real
 * synchronous LLM cycle - expect 10-60s; the mutation's pending state is the
 * UI's "agent is thinking" signal.
 */
export function useSpinAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (req: SpinRequest) => {
      const { data } = await api.post<SpinResponse>('/api/deep-agent/spin', req);
      return data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['deep-agents'] });
      queryClient.invalidateQueries({ queryKey: ['deep-agent', data.agentId] });
    },
  });
}

export interface ReviewRequest {
  agentId: string;
  episodeId: string;
}

export interface ReviewResponse {
  verdict: { verdict: 'approved' | 'needs-changes' | 'rejected'; issues: string[]; summary: string };
  reviewerEpisodeId: string;
  tierAdvanced?: { from: string; to: string };
}

/**
 * Adversarial review of one episode (write-once). An independent reviewer pass
 * audits the episode's claims against its own scope locks; the verdict lands
 * as a new episode in the timeline and may advance the agent's tier.
 */
export function useReviewEpisode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (req: ReviewRequest) => {
      const { data } = await api.post<ReviewResponse>('/api/deep-agent/review', req);
      return data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['deep-agents'] });
      queryClient.invalidateQueries({ queryKey: ['deep-agent', vars.agentId] });
    },
  });
}

// ── Missions (deep-agent charters linked to a B4M Agent) ───────────

/** Mission roster for one B4M agent. */
export function useAgentMissions(b4mAgentId: string | null) {
  return useQuery({
    queryKey: ['agent-missions', b4mAgentId],
    enabled: Boolean(b4mAgentId),
    queryFn: async () => {
      const { data } = await api.get<{ missions: AgentRosterItem[] }>(`/api/agents/${b4mAgentId}/missions`);
      return data.missions;
    },
    refetchInterval: 30_000,
    // Match the poll interval so remounts (tab switches) reuse the cache
    // instead of re-hitting the roster aggregation.
    staleTime: 30_000,
  });
}

export interface CreateMissionRequest {
  b4mAgentId: string;
  goal: string;
  role?: string;
  enableTools?: boolean;
}

export interface CreateMissionResponse {
  missionId: string;
  latency_ms: number;
}

/**
 * Create a mission for an agent and run its first wake inline (10-60s):
 * the mission is born alive, with the agent's persona leading the act step.
 */
export function useCreateMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ b4mAgentId, ...body }: CreateMissionRequest) => {
      const { data } = await api.post<CreateMissionResponse>(`/api/agents/${b4mAgentId}/missions`, body);
      return data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['agent-missions', vars.b4mAgentId] });
      queryClient.invalidateQueries({ queryKey: ['deep-agents'] });
    },
  });
}

/** Mission count per linked B4M agent for the caller (badges). */
export function useMissionCounts() {
  return useQuery({
    queryKey: ['mission-counts'],
    queryFn: async () => {
      const { data } = await api.get<{ counts: Record<string, number> }>('/api/deep-agent/mission-counts');
      return data.counts;
    },
    refetchInterval: 60_000,
    // Match the poll interval so remounts reuse the cache rather than re-running
    // the count aggregation on every mount.
    staleTime: 60_000,
  });
}
