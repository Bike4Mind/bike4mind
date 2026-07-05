import {
  CharterSchema,
  HandoffSchema,
  type Charter,
  type DeepAgentStore,
  type EvidenceTier,
  type LinkedAgentContext,
} from '@bike4mind/agents';
import {
  agentRepository,
  deepAgentCharterRepository,
  deepAgentHandoffRepository,
  serializeCharter,
  serializeHandoff,
} from '@bike4mind/database';
import { enrollDeepAgent } from './enroll';
import type { AgentRosterItem } from './consoleReads';

/**
 * Missions - the deep-agent capability surfaced on existing B4M Agents.
 *
 * An Agent (Cerebo) is WHO: name, avatar, persona, tools, credits. A Mission
 * is WHAT they're pursuing while you're away: a Charter linked via
 * `identity.linkedAgentId`, with its own episodes, memory, drives, and review
 * trail. One agent, many missions; each mission's `agentId` is its own key.
 *
 * Quests are temporal; a mission is the long-term meta-quest-chain an agent
 * lives. (Future: missions spawning sub-missions.)
 */

export interface CreateMissionInput {
  /** The B4M AgentModel id this mission belongs to. */
  b4mAgentId: string;
  /** The authenticated caller (must own the agent, or be admin). */
  callerUserId: string;
  callerIsAdmin?: boolean;
  goal: string;
  /** Toolbelt profile; defaults to 'default'. */
  role?: string;
  successCriteria?: string[];
  currentTier?: EvidenceTier;
}

export interface CreateMissionResult {
  missionId: string;
  charter: Charter;
}

/**
 * Enroll a Mission for an existing B4M Agent: authz against agent ownership,
 * identity derived from the agent (name, owner), linkage recorded. Persona +
 * tool policy are NOT copied - they're looked up fresh at act time via
 * `loadLinkedAgentContext`, so agent edits propagate to in-flight missions.
 */
export async function enrollMissionForAgent(
  input: CreateMissionInput,
  store: DeepAgentStore,
  enqueueWake: (missionId: string) => Promise<void> = async () => {}
): Promise<CreateMissionResult> {
  const agent = await agentRepository.findById(input.b4mAgentId);
  if (!agent) throw new Error(`no agent ${input.b4mAgentId}`);
  // Creating a mission is a write: require ownership (or admin). An agent with
  // no `userId` is org-owned or system - NOT public - so a strict `!==` (not
  // the old `agent.userId &&` short-circuit) correctly denies non-owners.
  if (agent.userId !== input.callerUserId && !input.callerIsAdmin) {
    throw new Error('not your agent');
  }
  const ownerUserId = agent.userId ?? input.callerUserId;

  const enrolled = await enrollDeepAgent(
    {
      ownerUserId,
      linkedAgentId: agent.id,
      name: agent.name,
      role: input.role ?? 'default',
      goal: { description: input.goal, successCriteria: input.successCriteria },
      ...(input.currentTier ? { currentTier: input.currentTier } : {}),
    },
    { store, enqueueWake }
  );
  return { missionId: enrolled.agentId, charter: enrolled.charter };
}

/** Mission roster for one B4M agent (same shape as the console roster). */
export async function listMissionsForAgent(b4mAgentId: string, limit = 50): Promise<AgentRosterItem[]> {
  const charterDocs = await deepAgentCharterRepository.listByLinkedAgentId(b4mAgentId, limit);
  const charters = charterDocs.map(doc => CharterSchema.parse(serializeCharter(doc)));
  const handoffDocs = await deepAgentHandoffRepository.findByAgentIds(charters.map(c => c.identity.agentId));
  const handoffByMission = new Map(handoffDocs.map(doc => [doc.agentId, HandoffSchema.parse(serializeHandoff(doc))]));

  return charters.map(charter => {
    const handoff = handoffByMission.get(charter.identity.agentId);
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

/**
 * Resolve a B4M agent by display name (case-insensitive) among the caller's
 * agents - the chat-tool path, where the model names the agent ("Cerebo")
 * rather than passing an id. Returns ALL exact matches: agent names are not
 * unique per user, so the caller must decide how to handle ambiguity rather
 * than silently acting on an arbitrary match.
 */
export async function findAgentsByName(callerUserId: string, agentName: string) {
  const agents = await agentRepository.listForUser(callerUserId);
  const needle = agentName.trim().toLowerCase();
  return agents.filter(a => a.name.trim().toLowerCase() === needle);
}

/** Compact markdown mission report for the chat `mission_status` tool. */
export function formatMissionStatusReport(agentName: string, missions: AgentRosterItem[]): string {
  if (missions.length === 0) return `${agentName} has no missions yet.`;
  const lines = [`${agentName} has ${missions.length} mission${missions.length === 1 ? '' : 's'}:`, ''];
  for (const m of missions) {
    lines.push(
      `- **${m.goal.length > 90 ? `${m.goal.slice(0, 90)}…` : m.goal}**`,
      `  ${m.wakeCount ?? 0} wakes · ${m.semanticMemoryCount} memories · ${m.currentTier} · v${m.version}` +
        (m.blockers.length ? ` · ⚠️ ${m.blockers.length} blocker${m.blockers.length === 1 ? '' : 's'}` : ''),
      ...(m.nextIntendedAction ? [`  Next: ${m.nextIntendedAction.slice(0, 140)}`] : [])
    );
  }
  return lines.join('\n');
}

/**
 * Act-time inheritance lookup: the linked agent's persona + tool policy.
 * Returns null when the agent vanished - the mission continues (deletion
 * shouldn't strand it) but the act layer runs it persona-less AND tool-less
 * (fail-closed; see createReActRunAct), so a deleted agent can never grant
 * back tools it had restricted.
 */
export async function loadLinkedAgentContext(linkedAgentId: string): Promise<LinkedAgentContext | null> {
  const agent = await agentRepository.findById(linkedAgentId);
  if (!agent) return null;
  return {
    ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
    ...(agent.allowedTools?.length ? { allowedTools: agent.allowedTools } : {}),
    ...(agent.deniedTools?.length ? { deniedTools: agent.deniedTools } : {}),
  };
}
