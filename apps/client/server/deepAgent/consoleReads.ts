import {
  CharterSchema,
  EpisodeSchema,
  HandoffSchema,
  type Charter,
  type Episode,
  type Handoff,
} from '@bike4mind/agents';
import {
  deepAgentCharterRepository,
  deepAgentEpisodeRepository,
  deepAgentHandoffRepository,
  serializeCharter,
  serializeEpisode,
  serializeHandoff,
} from '@bike4mind/database';

/**
 * Read models for the Deep Agent Console. Separate from DeepAgentStore on
 * purpose - that port is the wake cycle's persistence contract; these are
 * UI-shaped queries (roster summaries, detail views). Same Zod-parse-on-read
 * discipline so drifted documents fail loudly here, not in the browser.
 */

export interface AgentRosterItem {
  agentId: string;
  name: string;
  role: string;
  goal: string;
  currentTier: Charter['currentTier'];
  version: number;
  semanticMemoryCount: number;
  blockers: string[];
  updatedAt: string;
  /** Absent until the agent's first wake completes. */
  wakeCount?: number;
  lastWakeAt?: string;
  lastActionSummary?: string;
  nextIntendedAction?: string;
}

export interface AgentDetail {
  charter: Charter;
  handoff: Handoff | null;
  episodes: Episode[];
}

/** An owner's agents with their latest handoff state, newest activity first. */
export async function listAgentsForOwner(ownerUserId: string, limit = 50): Promise<AgentRosterItem[]> {
  const charterDocs = await deepAgentCharterRepository.listByOwnerUserId(ownerUserId, limit);
  const charters = charterDocs.map(doc => CharterSchema.parse(serializeCharter(doc)));
  const handoffDocs = await deepAgentHandoffRepository.findByAgentIds(charters.map(c => c.identity.agentId));
  const handoffByAgent = new Map(handoffDocs.map(doc => [doc.agentId, HandoffSchema.parse(serializeHandoff(doc))]));

  return charters.map(charter => {
    const handoff = handoffByAgent.get(charter.identity.agentId);
    return {
      agentId: charter.identity.agentId,
      name: charter.identity.name,
      role: charter.identity.role,
      goal: charter.goal.description,
      currentTier: charter.currentTier,
      version: charter.version,
      semanticMemoryCount: charter.semanticMemory.length,
      blockers: charter.blockers,
      updatedAt: charter.updatedAt,
      ...(handoff
        ? {
            wakeCount: handoff.wakeCount,
            lastWakeAt: handoff.lastWakeAt,
            lastActionSummary: handoff.lastActionSummary,
            nextIntendedAction: handoff.nextIntendedAction,
          }
        : {}),
    };
  });
}

/** Full charter + handoff + recent episode tail for one agent. */
export async function getAgentDetail(agentId: string, episodeLimit = 20): Promise<AgentDetail | null> {
  const charterDoc = await deepAgentCharterRepository.findByAgentId(agentId);
  if (!charterDoc) return null;
  const charter = CharterSchema.parse(serializeCharter(charterDoc));

  const handoffDoc = await deepAgentHandoffRepository.findByAgentId(agentId);
  const handoff = handoffDoc ? HandoffSchema.parse(serializeHandoff(handoffDoc)) : null;

  const episodeDocs = await deepAgentEpisodeRepository.findRecentByAgentId(agentId, episodeLimit);
  const episodes = episodeDocs.map(doc => EpisodeSchema.parse(serializeEpisode(doc)));

  return { charter, handoff, episodes };
}
