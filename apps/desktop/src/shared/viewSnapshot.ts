import { z } from 'zod';
import type { AgentState } from './agentState';

/*
 * The read-only picture of one orchestration that an Orchestrate view draws from, and the few things a
 * view may ask the host to do. Built-in views are the first consumers; the same contract is meant to be
 * the boundary for views that do not ship with the app, so it carries display data only: no paths,
 * prompts, transcripts or credentials, and every action names an agent that is in the snapshot.
 * Bump `contract` on any breaking change.
 */

export const VIEW_SNAPSHOT_CONTRACT = 1;

const AGENT_STATES = [
  'needs-you',
  'working',
  'done',
  'failed',
  'stopped',
  'idle',
] as const satisfies readonly AgentState[];
const agentStateSchema = z.enum(AGENT_STATES);

const viewAgentSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  state: agentStateSchema,
  /** The agent (or the root) that started this one. */
  parentId: z.string().min(1),
  /** 1 for a direct child of the root. */
  depth: z.number().int().min(1),
  updatedAt: z.string(),
  /** What it is doing now, or how its last reply ended, as one line for display. */
  now: z.string().optional(),
  /** The question it waits on the user for; present only while its state is 'needs-you'. */
  decision: z.strictObject({ id: z.string().min(1), question: z.string() }).optional(),
  pr: z.strictObject({ number: z.number().int().positive(), state: z.string() }).optional(),
  usdCost: z.number().nonnegative().optional(),
  credits: z.number().nonnegative().optional(),
});

export const viewSnapshotSchema = z.strictObject({
  contract: z.literal(VIEW_SNAPSHOT_CONTRACT),
  /** The orchestrating session. 'needs-you' when it waits on an approval itself. */
  root: z.strictObject({ id: z.string().min(1), state: z.enum(['needs-you', 'working', 'idle']) }),
  /** Most urgent first, in AGENT_STATE_PRIORITY order. */
  agents: z.array(viewAgentSchema),
});

export type ViewAgent = z.infer<typeof viewAgentSchema>;
export type ViewSnapshot = z.infer<typeof viewSnapshotSchema>;

/** What a view may ask for. The host checks every agent id against the snapshot it handed out. */
export const viewActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open-agent'), agentId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('open-root') }),
]);

export type ViewAction = z.infer<typeof viewActionSchema>;

/** The action, if it is well formed and names an agent this snapshot lists; undefined otherwise. */
export function acceptViewAction(snapshot: ViewSnapshot, action: unknown): ViewAction | undefined {
  const parsed = viewActionSchema.safeParse(action);
  if (!parsed.success) return undefined;
  const accepted = parsed.data;
  if (accepted.kind === 'open-agent' && !snapshot.agents.some(agent => agent.id === accepted.agentId)) {
    return undefined;
  }
  return accepted;
}
