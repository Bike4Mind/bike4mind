import type { ChatSessionSummary } from '@shared/chat';
import {
  matchRefs,
  parseRefQuery,
  refsInBranch,
  refsInTitle,
  type GithubRef,
  type RefMatch,
  type SessionRefs,
} from '@shared/githubRefs';
import type { PrSummary } from '@shared/pullRequest';

export type SessionRefHit = {
  session: ChatSessionSummary;
  match: RefMatch;
};

/**
 * Title and branch refs per summary object. A summary is replaced, never mutated, when its session
 * changes, so this is parsed once per version of a row rather than once per keystroke.
 */
const derived = new WeakMap<ChatSessionSummary, Pick<SessionRefs, 'title' | 'branch'>>();

function derivedRefs(session: ChatSessionSummary): Pick<SessionRefs, 'title' | 'branch'> {
  let refs = derived.get(session);
  if (!refs) {
    const branch = session.project?.workspaceBranch ?? session.project?.branch;
    refs = { title: refsInTitle(session.title), branch: refsInBranch(branch) };
    derived.set(session, refs);
  }
  return refs;
}

function prRefs(pr: PrSummary | undefined): GithubRef[] {
  if (!pr) return [];
  return [pr.repo ? { kind: 'pr', number: pr.number, repo: pr.repo.toLowerCase() } : { kind: 'pr', number: pr.number }];
}

/**
 * The sessions a search names by issue or PR, best first: a ref in the title or the bound PR
 * outranks one in the branch, which outranks one the transcript only mentions. Ties go to the most
 * recently updated. Empty when the query is not a ref.
 */
export function findSessionsByRef(
  query: string,
  sessions: readonly ChatSessionSummary[],
  prSummaries: ReadonlyMap<string, PrSummary>
): SessionRefHit[] {
  const ref = parseRefQuery(query);
  if (!ref) return [];
  const hits: SessionRefHit[] = [];
  for (const session of sessions) {
    const match = matchRefs(ref, {
      ...derivedRefs(session),
      pr: prRefs(prSummaries.get(session.id)),
      mention: session.githubRefs ?? [],
    });
    if (match) hits.push({ session, match });
  }
  return hits.sort((a, b) => b.match.score - a.match.score || b.session.updatedAt.localeCompare(a.session.updatedAt));
}
