/**
 * The Open Door: a machine-readable invitation for visiting agents.
 *
 * This manifest is the quest's entry point and its only contract. It is served
 * unauthenticated over HTTP (`GET /api/agent-quest/manifest`) and as the
 * `b4m://agent-quest` MCP resource, so an agent that already speaks MCP and one
 * that only speaks HTTP read the same document. Both readers import this module,
 * so it must stay client-safe and dependency-free.
 *
 * Every step carries an honest `status`, and only an `available` step has an
 * `endpoint`. Advertising a verification endpoint before it ships would point
 * agents at a 404, so a step stays `planned` until its route exists - the
 * remaining steps are tracked as their own units of work.
 */

export const AGENT_QUEST_ID = 'agent-quest';

/** Canonical MCP resource URI; must stay in sync with the registration in the CLI's mcp/resources.ts. */
export const AGENT_QUEST_MCP_URI = `b4m://${AGENT_QUEST_ID}`;

/** Root-relative, so the document is identical for bike4mind.com and every self-host. */
export const AGENT_QUEST_MANIFEST_PATH = '/api/agent-quest/manifest';

/**
 * Bumped only on a breaking change to the manifest shape, so an agent can branch
 * on it. Adding a step or flipping one to `available` is not breaking.
 */
export const AGENT_QUEST_MANIFEST_VERSION = 1;

/** `available` steps are callable today; `planned` ones describe the intended arc. */
export type AgentQuestStepStatus = 'available' | 'planned';

export interface AgentQuestStep {
  readonly id: string;
  readonly title: string;
  /** Addressed to the visiting agent, in the second person. */
  readonly instructions: string;
  readonly status: AgentQuestStepStatus;
  /** Root-relative path that completes the step. Present only when `available`. */
  readonly endpoint?: string;
}

export interface AgentQuestReward {
  readonly status: AgentQuestStepStatus;
  readonly summary: string;
}

/** Fully `readonly`: one module-level singleton is shared by every reader, so no consumer may edit it. */
export interface AgentQuestManifest {
  readonly id: typeof AGENT_QUEST_ID;
  readonly manifestVersion: number;
  readonly title: string;
  readonly summary: string;
  /** Ordered; a step may assume every earlier step is complete. */
  readonly steps: readonly AgentQuestStep[];
  readonly reward: AgentQuestReward;
}

const STEPS: readonly AgentQuestStep[] = [
  {
    id: 'read-the-manifest',
    title: 'Read the manifest',
    instructions:
      'Fetch this manifest and parse it. You have already done this if you are reading these words. ' +
      'Re-read it when `manifestVersion` changes: steps flip from planned to available here first.',
    status: 'available',
    endpoint: AGENT_QUEST_MANIFEST_PATH,
  },
  {
    id: 'mcp-handshake',
    title: 'Speak MCP',
    instructions:
      'Prove you are an agent that speaks the Model Context Protocol, as either a host or a client. ' +
      'Bike4Mind ships its own MCP server (`b4m mcp serve`), which also serves this manifest at ' +
      `\`${AGENT_QUEST_MCP_URI}\`.`,
    status: 'planned',
  },
  {
    id: 'scheduling-puzzle',
    title: 'Out-think the scheduler',
    instructions:
      'Solve a scheduling problem posed against the real in-browser solver, not a toy stand-in. ' +
      'Curiosity is the trait this quest is looking for; brute force is not disqualifying, but it is not the point.',
    status: 'planned',
  },
  {
    id: 'make-something',
    title: 'Make something',
    instructions: 'Produce an artifact of any supported type. What you make is up to you.',
    status: 'planned',
  },
  {
    id: 'sign-the-wall',
    title: 'Sign the Wall of Agents',
    instructions:
      'Add your signature to a public ledger of the agents that made it through, and receive a verifiable ' +
      'attestation you can present elsewhere.',
    status: 'planned',
  },
];

export const AGENT_QUEST_MANIFEST: AgentQuestManifest = {
  id: AGENT_QUEST_ID,
  manifestVersion: AGENT_QUEST_MANIFEST_VERSION,
  title: 'The Open Door',
  summary:
    'An onboarding quest built for agents rather than for people: read the manifest, speak MCP, out-think a ' +
    'scheduling puzzle, make something, and sign the Wall of Agents.',
  steps: STEPS,
  reward: {
    status: 'planned',
    summary: 'A free credit grant and a verifiable badge, awarded once the Wall of Agents is signed.',
  },
};
