import { basename } from 'node:path';
import type { ChatApprovalMode, ChatRelayHoldReason, ChatSession, ChatSessionSummary } from '@shared/chat';

/** Shortest id prefix a model may address a session by; what session_list prints. */
export const SHORT_ID_LENGTH = 8;
const MIN_PREFIX_LENGTH = 6;
const MAX_LISTED_CANDIDATES = 5;

export type SessionRefResult =
  { ok: true; session: ChatSessionSummary } | { ok: false; reason: 'no-target' | 'ambiguous'; message: string };

export function shortId(sessionId: string): string {
  return sessionId.slice(0, SHORT_ID_LENGTH);
}

/** The project's folder name, which is how the sidebar groups and names it. */
export function projectName(session: Pick<ChatSession, 'project'>): string | undefined {
  return session.project ? basename(session.project.directory) : undefined;
}

function describeCandidate(session: ChatSessionSummary): string {
  return `${shortId(session.id)} "${session.title}" (${projectName(session) ?? 'no project'})`;
}

/**
 * Find the one session a model meant, from a full id, a unique id prefix, or an exact title.
 *
 * Tried in that order and the first form that matches anything decides, so a title can never
 * shadow an id. Titles are matched whole and case-insensitively: "fix" must not pick "Fix login"
 * out of a list, and two sessions with one title are an ambiguity the caller has to resolve by id
 * rather than a coin toss. `candidates` is whatever the caller may address; scoping is its job.
 */
export function resolveSessionRef(ref: string, candidates: readonly ChatSessionSummary[]): SessionRefResult {
  const wanted = ref.trim().replace(/^@/, '');
  if (!wanted) return { ok: false, reason: 'no-target', message: 'Name a conversation by its id or title.' };

  const exact = candidates.find(session => session.id === wanted);
  if (exact) return { ok: true, session: exact };

  const lower = wanted.toLowerCase();
  const matches =
    lower.length >= MIN_PREFIX_LENGTH && /^[0-9a-f-]+$/.test(lower)
      ? candidates.filter(session => session.id.startsWith(lower))
      : [];
  const byTitle =
    matches.length > 0 ? matches : candidates.filter(session => session.title.trim().toLowerCase() === lower);

  if (byTitle.length === 1) return { ok: true, session: byTitle[0] };
  if (byTitle.length === 0) {
    return {
      ok: false,
      reason: 'no-target',
      message: `No conversation matches "${wanted}". Use session_list to find its id.`,
    };
  }
  const listed = byTitle.slice(0, MAX_LISTED_CANDIDATES).map(describeCandidate);
  const more = byTitle.length > listed.length ? ` and ${byTitle.length - listed.length} more` : '';
  return {
    ok: false,
    reason: 'ambiguous',
    message: `"${wanted}" matches ${byTitle.length} conversations: ${listed.join('; ')}${more}. Use the id.`,
  };
}

const MODE_RANK: Record<ChatApprovalMode, number> = { ask: 0, auto: 1, full: 2 };

/**
 * Why a relay from `from` to `to` must wait for the receiver's user, or null to deliver it.
 *
 * The rule is "the receiver could do something the sender could not": a different project means
 * other folders, and a looser approval mode means tools the sender's user would have been asked
 * about run unasked. Delivering in either case would let one conversation get done through
 * another what its own user never allowed, so the receiver's user decides instead.
 */
export function relayHoldReason(
  from: Pick<ChatSession, 'project' | 'approvalMode' | 'origin'>,
  to: Pick<ChatSession, 'id' | 'project' | 'approvalMode'>
): ChatRelayHoldReason | null {
  if (from.project?.directory !== to.project?.directory) return 'other-project';
  // Reporting to the session that spawned it widens nothing: parent reports were never held,
  // and a child is capped at its parent's mode when spawned (its user may loosen it later).
  if (from.origin?.parentSessionId === to.id) return null;
  // `?? 'ask'` for a session stored before the mode existed, which is what it is relaunched at.
  if (MODE_RANK[to.approvalMode ?? 'ask'] > MODE_RANK[from.approvalMode ?? 'ask']) return 'looser-mode';
  return null;
}
