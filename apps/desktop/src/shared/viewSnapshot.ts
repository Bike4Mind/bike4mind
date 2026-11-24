import type { PlanProgress } from '@bike4mind/common';
import { z } from 'zod';
import { isStoppableState, type AgentState } from './agentState';
import { PR_ATTENTIONS } from './prAttention';
import { MAX_LABEL_CHARS, MAX_OPTIONS, MAX_OTHER_CHARS } from './questions';
import { QUICK_SUMMARY_MAX } from './watch';

/*
 * The read-only picture of one orchestration that an Orchestrate view draws from, and the few things a
 * view may ask the host to do. Built-in views are the first consumers; the same contract is meant to be
 * the boundary for views that do not ship with the app, so it carries display data only: no paths,
 * prompts, transcripts or credentials, and every action names an agent, decision or approval that is in
 * the snapshot. Bump `contract` on any breaking change.
 */

export const VIEW_SNAPSHOT_CONTRACT = 2;

// Additive: 'waiting' and 'paused' joined without a contract bump, since only built-in views consume it today.
const AGENT_STATES = [
  'needs-you',
  'working',
  'waiting',
  'done',
  'failed',
  'paused',
  'stopped',
  'idle',
] as const satisfies readonly AgentState[];
const agentStateSchema = z.enum(AGENT_STATES);

const id = z.string().min(1);

/** A worker's question to the user, with the option labels an `answer` action may pick from. */
const viewDecisionSchema = z.strictObject({
  id,
  question: z.string(),
  options: z.array(z.string().min(1).max(MAX_LABEL_CHARS)).min(1).max(MAX_OPTIONS),
  multiSelect: z.boolean().optional(),
  /**
   * Whether a view may offer each option as a one-click answer. The host decides it from the real labels,
   * so it holds when the labels shown are placeholders; absent or false sends the user to the full card.
   */
  oneClick: z.boolean().optional(),
});

/** Plan progress as display data: counts and two one-line labels, never the items' notes. */
const viewPlanSchema = z
  .strictObject({
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    // Same cap as a plan item's text (planLeafSchema).
    current: z.string().max(200).optional(),
    next: z.string().max(200).optional(),
  })
  .refine(plan => plan.done <= plan.total, { message: 'done exceeds total' }) satisfies z.ZodType<PlanProgress>;

const viewAgentSchema = z.strictObject({
  id,
  title: z.string(),
  state: agentStateSchema,
  /** The agent (or the root) that started this one. */
  parentId: id,
  /** 1 for a direct child of the root. */
  depth: z.number().int().min(1),
  updatedAt: z.string(),
  /** What it is doing now, or how its last reply ended, as one line for display. */
  now: z.string().optional(),
  /** The question it waits on the user for; present only while its state is 'needs-you'. */
  decision: viewDecisionSchema.optional(),
  /** The PR icon status the sidebar draws (shared/prAttention), so every view shows the same state. */
  pr: z
    .strictObject({
      number: z.number().int().positive(),
      state: z.string(),
      /** `owner/repo`, so a view can link to the PR without asking the host. */
      repo: z.string().optional(),
      attention: z.enum(PR_ATTENTIONS).optional(),
      behind: z.boolean().optional(),
      autoMerge: z.boolean().optional(),
      stale: z.boolean().optional(),
    })
    .optional(),
  usdCost: z.number().nonnegative().optional(),
  credits: z.number().nonnegative().optional(),
  /** Progress of its latest plan; absent when it has none. */
  plan: viewPlanSchema.optional(),
});

/**
 * A call parked at the approval gate that may be allowed once or denied without its full card: the same
 * set the menu bar and the mini window answer (isQuickApproval in ./watch).
 */
const viewApprovalSchema = z.strictObject({
  id,
  /** The root's id or an agent's. */
  sessionId: id,
  /** Tool and target on one line, as the menu bar shows it. */
  label: z.string().min(1).max(QUICK_SUMMARY_MAX),
});

export const viewSnapshotSchema = z.strictObject({
  contract: z.literal(VIEW_SNAPSHOT_CONTRACT),
  /** The orchestrating session. 'needs-you' when it waits on an approval itself. */
  root: z.strictObject({ id, state: z.enum(['needs-you', 'working', 'idle']) }),
  /** Most urgent first, in AGENT_STATE_PRIORITY order. */
  agents: z.array(viewAgentSchema),
  /** Quick approvals, oldest session first; absent when there are none or the host did not read them. */
  approvals: z.array(viewApprovalSchema).optional(),
});

export type ViewPlan = z.infer<typeof viewPlanSchema>;
export type ViewAgent = z.infer<typeof viewAgentSchema>;
export type ViewDecision = z.infer<typeof viewDecisionSchema>;
export type ViewApproval = z.infer<typeof viewApprovalSchema>;
export type ViewSnapshot = z.infer<typeof viewSnapshotSchema>;

/** The same shape the decision card sends (TaskDecisionAnswer in ./orchestration): one entry, as a decision asks one question. */
const viewAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('answered'),
    answers: z
      .array(
        z.strictObject({
          selected: z.array(z.string().min(1).max(MAX_LABEL_CHARS)).max(MAX_OPTIONS),
          other: z.string().trim().min(1).max(MAX_OTHER_CHARS).optional(),
        })
      )
      .length(1),
  }),
  z.strictObject({ status: z.literal('skipped') }),
]);

/** What a view may ask for. The host checks every id against the snapshot it handed out (acceptViewAction). */
export const viewActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open-agent'), agentId: id }),
  z.strictObject({ kind: z.literal('open-pr'), agentId: id }),
  z.strictObject({ kind: z.literal('open-root') }),
  z.strictObject({ kind: z.literal('answer'), agentId: id, decisionId: id, answer: viewAnswerSchema }),
  /** Never 'always': a standing rule is only ever set from the full card. */
  z.strictObject({ kind: z.literal('approve'), approvalId: id, mode: z.enum(['once', 'deny']) }),
  z.strictObject({ kind: z.literal('stop'), agentId: id }),
]);

export type ViewAction = z.infer<typeof viewActionSchema>;
type AnswerAction = Extract<ViewAction, { kind: 'answer' }>;

/**
 * Whether the answer fits the decision as the snapshot shows it: picks among its option labels, at most
 * one unless it is multi-select, typed text instead of a pick on a single-select question (the card's
 * own rule, sanitizeAnswers in ./questions), and something chosen or typed.
 */
function answerFits(decision: ViewDecision, answer: AnswerAction['answer']): boolean {
  if (answer.status === 'skipped') return true;
  const [{ selected, other }] = answer.answers;
  const offered = new Set(decision.options);
  if (new Set(selected).size !== selected.length || !selected.every(label => offered.has(label))) return false;
  if (!decision.multiSelect && (selected.length > 1 || (other !== undefined && selected.length > 0))) return false;
  return selected.length > 0 || other !== undefined;
}

function fitsSnapshot(snapshot: ViewSnapshot, action: ViewAction): boolean {
  switch (action.kind) {
    case 'open-root':
      return true;
    case 'open-agent':
      return snapshot.agents.some(agent => agent.id === action.agentId);
    case 'open-pr':
      return snapshot.agents.some(agent => agent.id === action.agentId && agent.pr !== undefined);
    case 'stop':
      return snapshot.agents.some(agent => agent.id === action.agentId && isStoppableState(agent.state));
    case 'approve':
      return (snapshot.approvals ?? []).some(approval => approval.id === action.approvalId);
    case 'answer': {
      const agent = snapshot.agents.find(candidate => candidate.id === action.agentId);
      const decision = agent?.state === 'needs-you' ? agent.decision : undefined;
      return decision?.id === action.decisionId && answerFits(decision, action.answer);
    }
  }
}

/**
 * The action, if it is well formed and everything it names is pending in this snapshot: a listed agent,
 * the decision that agent waits on, a listed quick approval, an agent in a state Stop applies to.
 * Undefined otherwise.
 */
export function acceptViewAction(snapshot: ViewSnapshot, action: unknown): ViewAction | undefined {
  const parsed = viewActionSchema.safeParse(action);
  if (!parsed.success) return undefined;
  return fitsSnapshot(snapshot, parsed.data) ? parsed.data : undefined;
}
