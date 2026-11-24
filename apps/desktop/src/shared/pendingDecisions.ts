import {
  isResumableStop,
  SERVER_CREDENTIALS_STOP,
  type ChatHeldRelay,
  type ChatMessage,
  type ChatSessionSummary,
  type ChatToolCall,
} from './chat';
import { isMcpConfigToolName } from './mcp';
import { pendingCallsIn } from './needsYou';
import { pendingDecisionOf, type PendingDecision as TaskDecision } from './orchestration';
import { descendantsOf } from './spawnTree';
import { regenerableReply } from './threadRewind';

/*
 * Everything a session is waiting on the user for, as one list a parent can answer without opening
 * the session. DERIVED from what the renderer already reads (the summary, the transcript, the held
 * relays) and never stored: a resolve anywhere changes that source, and the card goes with it.
 */

type DecisionBase = {
  sessionId: string;
  /** Stable for as long as the decision is open, and unique within its session. */
  decisionId: string;
};

/** A tool call parked at the approval gate (tool approvals, ask_user, request_directory, MCP add, grants). */
export type ApprovalPendingDecision = DecisionBase & {
  kind: 'approval';
  approvalId: string;
  call: ChatToolCall;
  /** The card asks for secrets, which belong in the session's own details rather than a flat list. */
  collectsSecrets: boolean;
};

/** A worker task blocked on a decision only the user can make (answerTaskDecision). */
export type QuestionPendingDecision = DecisionBase & { kind: 'question'; decision: TaskDecision };

/** A relayed message waiting for the receiving session's user to deliver or decline it. */
export type HeldRelayPendingDecision = DecisionBase & { kind: 'held-relay'; held: ChatHeldRelay };

/** The last turn failed; Retry runs its prompt again (regenerateReply). */
export type ErrorPendingDecision = DecisionBase & { kind: 'error'; messageId: string; error: string };

/** The last turn paused on a turn budget or an expired session; Continue carries it on (continueReply). */
export type StoppedPendingDecision = DecisionBase & { kind: 'stopped'; messageId: string; stopReason: string };

// Room for 'trust' and 'sign-in' later: every consumer switches exhaustively on `kind`.
export type PendingDecision =
  | ApprovalPendingDecision
  | QuestionPendingDecision
  | HeldRelayPendingDecision
  | ErrorPendingDecision
  | StoppedPendingDecision;

export type PendingDecisionKind = PendingDecision['kind'];

/** What one session's decisions are derived from. Anything not loaded is simply absent. */
export type SessionDecisionSource = {
  session: Pick<ChatSessionSummary, 'id' | 'workerTask'>;
  messages?: readonly ChatMessage[];
  held?: readonly ChatHeldRelay[];
  /** A turn is running, so the last message is the live reply rather than a finished one. */
  processing?: boolean;
};

/** Stop reasons Retry cannot fix: re-sending would fail the same way, or the user stopped it. */
const NOT_RETRYABLE = new Set(['context_limit', 'aborted', SERVER_CREDENTIALS_STOP]);

/** A session's open decisions: approvals, then its task question, then held relays, then the last turn. */
export function pendingDecisionsOf({
  session,
  messages = [],
  held = [],
  processing = false,
}: SessionDecisionSource): PendingDecision[] {
  const sessionId = session.id;
  const decisions: PendingDecision[] = [];

  for (const call of pendingCallsIn(messages)) {
    const approvalId = call.approvalId;
    if (!approvalId) continue;
    decisions.push({
      kind: 'approval',
      sessionId,
      decisionId: `approval:${approvalId}`,
      approvalId,
      call,
      collectsSecrets: isMcpConfigToolName(call.name),
    });
  }

  const question = pendingDecisionOf(session.workerTask);
  if (question)
    decisions.push({ kind: 'question', sessionId, decisionId: `question:${question.id}`, decision: question });

  for (const entry of held) {
    decisions.push({ kind: 'held-relay', sessionId, decisionId: `held:${entry.id}`, held: entry });
  }

  const lastTurn = processing ? undefined : lastTurnDecision(sessionId, messages);
  if (lastTurn) decisions.push(lastTurn);
  return decisions;
}

function lastTurnDecision(
  sessionId: string,
  messages: readonly ChatMessage[]
): ErrorPendingDecision | StoppedPendingDecision | undefined {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return undefined;
  // Checked first: an expired session's turn also carries `error`, but Continue resumes it in place.
  if (last.stopReason && isResumableStop(last.stopReason)) {
    return {
      kind: 'stopped',
      sessionId,
      decisionId: `stopped:${last.id}`,
      messageId: last.id,
      stopReason: last.stopReason,
    };
  }
  if (!last.error || NOT_RETRYABLE.has(last.stopReason ?? '')) return undefined;
  if (regenerableReply(messages)?.id !== last.id) return undefined;
  return { kind: 'error', sessionId, decisionId: `error:${last.id}`, messageId: last.id, error: last.error };
}

// Not used by the flat strip (which reads the roster); kept for the nested Agent-view tree's roll-up.
/**
 * Every descendant of `rootId` with something open, shallowest first, keyed by session. The root
 * itself is left out: its own decisions are already in its own conversation.
 */
export function pendingDecisionsInTree(
  sessions: readonly ChatSessionSummary[],
  rootId: string,
  sources: ReadonlyMap<string, Omit<SessionDecisionSource, 'session'>>
): Map<string, PendingDecision[]> {
  const byDepth = descendantsOf(sessions, rootId)
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index);
  const tree = new Map<string, PendingDecision[]>();
  for (const { session } of byDepth) {
    const decisions = pendingDecisionsOf({ session, ...sources.get(session.id) });
    if (decisions.length > 0) tree.set(session.id, decisions);
  }
  return tree;
}

/** The chain from the top of `sessionId`'s spawn tree down to it, for "root > child > grandchild". */
export function spawnPathOf<T extends { id: string; parentId?: string }>(nodes: readonly T[], sessionId: string): T[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const path: T[] = [];
  const visited = new Set<string>();
  let current = byId.get(sessionId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}
