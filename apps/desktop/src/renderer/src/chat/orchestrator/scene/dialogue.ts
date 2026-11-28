import type { ChatToolCall } from '@shared/chat';
import { REQUEST_DIRECTORY_TOOL_NAME } from '@shared/directoryRequest';
import { isMcpConfigToolName } from '@shared/mcp';
import { ASK_USER_TOOL_NAME } from '@shared/questions';
import type { ApprovalPendingDecision, PendingDecision, PendingDecisionKind } from '@shared/pendingDecisions';
import { summarizeInput } from '../../toolRows';

/*
 * A scene's dialogue box (SceneDialogue.tsx): what it queues, what a plain command approval shows,
 * when its Allow choices unlock, and which key does what. Kept free of React so each rule is tested alone.
 */

/** Approvals first (an agent is blocked mid-turn), then questions, relays, paused and failed turns. */
const KIND_ORDER: Record<PendingDecisionKind, number> = {
  approval: 0,
  question: 1,
  'held-relay': 2,
  stopped: 3,
  error: 4,
};

/** Every open decision as one queue: by kind, then in roster order, then in the agent's own order. */
export function dialogueQueue(byId: ReadonlyMap<string, readonly PendingDecision[]>): PendingDecision[] {
  return [...byId.values()]
    .flat()
    .map((decision, index) => ({ decision, index }))
    .sort((left, right) => KIND_ORDER[left.decision.kind] - KIND_ORDER[right.decision.kind] || left.index - right.index)
    .map(({ decision }) => decision);
}

/**
 * The front of the queue: the decision with this key, else the first one from the session with this id
 * (a clicked character), else the head when it has gone.
 */
export function queueIndex(queue: readonly PendingDecision[], key: string | undefined): number {
  if (key === undefined) return 0;
  const exact = queue.findIndex(decision => decisionKey(decision) === key);
  if (exact >= 0) return exact;
  return Math.max(
    0,
    queue.findIndex(decision => decision.sessionId === key)
  );
}

export const decisionKey = (decision: PendingDecision) => `${decision.sessionId}:${decision.decisionId}`;

/** A plain approval the box can draw in its own style and answer by key. */
export interface CommandApproval {
  approvalId: string;
  /** What the agent wants, for the line under its name. */
  ask: string;
  /** The agent's own one-line reason, when it gave one. */
  description: string;
  /** The exact text being approved, shown whole and never cut. */
  text: string;
  /** Allow in this chat is offered (the card would offer it too). */
  allowInChat: boolean;
  /** What "Allow in this chat" covers, as the card's scope line says it. */
  scope?: string;
  /** The full card has choices this box leaves out (in this project, always allow). */
  moreInDetails: boolean;
}

const SHELL_TOOLS = new Set(['bash_execute', 'bash_background']);
const MAX_DESCRIPTION_CHARS = 140;

function descriptionLine(description: string | undefined): string {
  const flat = (description ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_DESCRIPTION_CHARS ? flat : `${flat.slice(0, MAX_DESCRIPTION_CHARS - 3).trimEnd()}...`;
}

function askFor(call: ChatToolCall): string {
  if (call.name === 'bash_background') return 'wants to start a command in the background';
  if (SHELL_TOOLS.has(call.name)) return 'wants to run a command';
  return `wants to use ${call.name}`;
}

/**
 * The approval as the box draws it, or undefined when it needs the full card: a diff to read, a choice
 * of answers, an irreversible call, secrets, a question form, or a directory or MCP request. Those keep
 * the thread's own card (DecisionCard) inside the box, so nothing about them is restyled or dropped.
 */
export function commandApprovalOf(decision: PendingDecision): CommandApproval | undefined {
  if (decision.kind !== 'approval') return undefined;
  return plainApproval(decision);
}

function plainApproval({ call, approvalId, collectsSecrets }: ApprovalPendingDecision): CommandApproval | undefined {
  const hasDiff = call.approvalDiff !== undefined || (call.approvalDiffs?.length ?? 0) > 0;
  const needsCard =
    collectsSecrets ||
    hasDiff ||
    call.approvalChoice !== undefined ||
    call.approvalIrreversible === true ||
    (call.approvalParts?.length ?? 0) > 0 ||
    // Cards with a form of their own rather than a yes or no.
    call.name === ASK_USER_TOOL_NAME ||
    call.name === REQUEST_DIRECTORY_TOOL_NAME ||
    isMcpConfigToolName(call.name);
  const text = call.approvalDetail ?? summarizeInput(call);
  // Nothing to read means nothing to consent to here; the card shows the call its own way.
  if (needsCard || text.trim() === '') return undefined;
  const allowInChat = call.approvalOnceOnly !== true;
  return {
    approvalId,
    ask: askFor(call),
    description: descriptionLine(call.approvalDescription),
    text,
    allowInChat,
    scope: allowInChat ? call.approvalAlways : undefined,
    moreInDetails:
      allowInChat && ((call.approvalProjectRules?.length ?? 0) > 0 || (call.approvalRules?.length ?? 0) > 0),
  };
}

export type DialogueKeyAction = 'once' | 'chat' | 'deny' | 'open' | 'expand' | 'next' | 'previous' | 'minimize';

/** What a key does in the box, or undefined. Modified keys are left to the app (Cmd+C must still copy). */
export function dialogueKeyAction(event: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): DialogueKeyAction | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return undefined;
  // Arrows rather than Tab, so Tab still walks the box's buttons for keyboard and screen-reader users.
  if (event.key === 'ArrowRight') return 'next';
  if (event.key === 'ArrowLeft') return 'previous';
  if (event.key === 'Escape') return 'minimize';
  switch (event.key.toLowerCase()) {
    case 'a':
      return 'once';
    case 'c':
      return 'chat';
    case 'd':
      return 'deny';
    case 'o':
      return 'open';
    case 'e':
      return 'expand';
    default:
      return undefined;
  }
}

/** Marks the dialogue box so the ambient settle-key handler (ChatShell) leaves its answer keys alone. */
export const SCENE_DIALOGUE_ATTR = 'data-scene-dialogue';

export const inSceneDialogue = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(`[${SCENE_DIALOGUE_ATTR}]`) !== null;
