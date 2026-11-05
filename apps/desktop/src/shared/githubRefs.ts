import type { ChatMessage } from './chat';
import { isPrNumber } from './pullRequest';

/**
 * GitHub issue and PR references: parsing what the user types into the session search, and
 * collecting the refs a session carries (its title, branch, bound PR, and the refs its transcript
 * mentions) so the search can find a session from an issue or PR number.
 */

/** `either` is a `#N` that could name an issue or a PR: GitHub numbers both from one sequence. */
export type GithubRefKind = 'pr' | 'issue' | 'either';

export type GithubRef = {
  kind: GithubRefKind;
  number: number;
  /** Lowercased `owner/repo`, or a bare short name such as `docs` from `docs#12`. Absent means unstated. */
  repo?: string;
};

/** Where a session's ref came from, strongest first. */
export type GithubRefSource = 'title' | 'pr' | 'branch' | 'mention';

/** Cap on the refs remembered per session, so a long transcript cannot bloat its summary. */
export const MAX_MENTIONED_REFS = 50;

/**
 * A block naming more distinct refs than this is a listing (`gh pr list`, a search result, a
 * changelog) - the session reading about many PRs, not working on one - and is skipped.
 */
const LISTING_THRESHOLD = 5;

const REPO = '[A-Za-z0-9][A-Za-z0-9._-]*';
const OWNER_REPO = `${REPO}/${REPO}`;

const URL_PATTERN = new RegExp(`https?://(?:www\\.)?github\\.com/(${OWNER_REPO})/(pull|issues)/(\\d+)(?!\\d)`, 'gi');

const KIND_WORDS: Record<string, GithubRefKind> = {
  pr: 'pr',
  pull: 'pr',
  issue: 'issue',
  iss: 'issue',
};

function toNumber(digits: string): number | null {
  const number = Number(digits);
  return isPrNumber(number) ? number : null;
}

function makeRef(kind: GithubRefKind, digits: string, repo?: string): GithubRef | null {
  const number = toNumber(digits);
  if (number === null) return null;
  return repo ? { kind, number, repo: repo.toLowerCase() } : { kind, number };
}

/**
 * What the user typed into the search box, read as a ref - or null when it is not one. Accepts
 * `6526`, `#6526`, `PR#6526`, `pr 6526`, `issue #12`, `owner/repo#6526`, `docs#12`, and a pasted
 * issue or pull request URL (with any trailing path, query or fragment).
 */
export function parseRefQuery(text: string): GithubRef | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const url = new RegExp(`^${URL_PATTERN.source}(?:[/?#].*)?$`, 'i').exec(trimmed);
  if (url) return makeRef(url[2].toLowerCase() === 'pull' ? 'pr' : 'issue', url[3], url[1]);

  const keyword = /^(pr|pull|issue|iss)\s*#?\s*(\d+)$/i.exec(trimmed);
  if (keyword) return makeRef(KIND_WORDS[keyword[1].toLowerCase()], keyword[2]);

  const bare = /^#?(\d+)$/.exec(trimmed);
  if (bare) return makeRef('either', bare[1]);

  const named = new RegExp(`^(${OWNER_REPO}|${REPO})#(\\d+)$`).exec(trimmed);
  if (named) return makeRef('either', named[2], named[1]);

  return null;
}

function refKey(ref: GithubRef): string {
  return `${ref.kind}:${ref.repo ?? ''}#${ref.number}`;
}

function pushUnique(into: GithubRef[], seen: Set<string>, ref: GithubRef | null): void {
  if (!ref) return;
  const key = refKey(ref);
  if (seen.has(key)) return;
  seen.add(key);
  into.push(ref);
}

/**
 * The refs a session title names, in the `<issue> | PR#<pr> | topic` style and its variations:
 * `PR#6526` / `PR 6526` is a PR and `issue#12` an issue. A `#5710`, `docs#12` or `owner/repo#12`
 * with no kind word is read as the issue when the title also names a PR (the convention puts the
 * issue first), and as either otherwise.
 */
export function refsInTitle(title: string): GithubRef[] {
  const found: GithubRef[] = [];
  const seen = new Set<string>();
  for (const match of title.matchAll(URL_PATTERN)) {
    pushUnique(found, seen, makeRef(match[2].toLowerCase() === 'pull' ? 'pr' : 'issue', match[3], match[1]));
  }
  const withoutUrls = title.replace(URL_PATTERN, ' ');
  const token = new RegExp(
    `(?:^|[^A-Za-z0-9#/._-])(?:(pr|pull|issue|iss)\\s*#?\\s*|(${OWNER_REPO}|${REPO})?#)(\\d+)\\b`,
    'gi'
  );
  const pending: Array<{ kind?: GithubRefKind; repo?: string; digits: string }> = [];
  for (const match of withoutUrls.matchAll(token)) {
    const [, word, repo, digits] = match;
    if (word) pending.push({ kind: KIND_WORDS[word.toLowerCase()], digits });
    else pending.push({ repo, digits });
  }
  const namesPr = pending.some(entry => entry.kind === 'pr');
  for (const entry of pending) {
    const kind = entry.kind ?? (namesPr ? 'issue' : 'either');
    pushUnique(found, seen, makeRef(kind, entry.digits, entry.repo));
  }
  return found;
}

/**
 * Refs a branch name spells out on purpose: `pr-12`, `issue_34`, `fix/issue-56-thing`, `gh-78`.
 * A bare number in a branch is too often a date or a version to count.
 */
export function refsInBranch(branch: string | undefined): GithubRef[] {
  if (!branch) return [];
  const found: GithubRef[] = [];
  const seen = new Set<string>();
  for (const match of branch.matchAll(/(?:^|[/_.-])(pr|pull|issue|issues|gh)[-_]?(\d+)(?=$|[/_.-])/gi)) {
    const word = match[1].toLowerCase();
    const kind: GithubRefKind = word === 'pr' || word === 'pull' ? 'pr' : word === 'gh' ? 'either' : 'issue';
    pushUnique(found, seen, makeRef(kind, match[2]));
  }
  return found;
}

/** `gh pr view 12 -R owner/repo` and friends; group 3 is the rest of that one command. */
const GH_COMMAND =
  /\bgh[ \t]+(pr|issue)[ \t]+(view|checkout|merge|comment|edit|close|reopen|review|diff|checks|ready|develop)\b([^\n;&|]*)/gi;
const REPO_FLAG = new RegExp(`(?:-R|--repo)[ \\t=]+(${OWNER_REPO})`);
const CLOSING = new RegExp(
  `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(?:(${OWNER_REPO})#|#|https?://(?:www\\.)?github\\.com/(${OWNER_REPO})/issues/)(\\d+)`,
  'gi'
);

/** Refs one block of text names: issue and PR URLs, `gh pr|issue <verb> N` commands, and a PR body's closing keywords. */
export function refsInText(text: string): GithubRef[] {
  if (!text || (!text.includes('github.com') && !/\bgh\s+(?:pr|issue)\b/.test(text))) return [];
  const found: GithubRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    pushUnique(found, seen, makeRef(match[2].toLowerCase() === 'pull' ? 'pr' : 'issue', match[3], match[1]));
  }
  for (const match of text.matchAll(GH_COMMAND)) {
    const rest = match[3];
    const digits = rest.split(/[ \t]+/).find(word => /^#?\d+$/.test(word));
    if (!digits) continue;
    const repo = REPO_FLAG.exec(rest)?.[1];
    pushUnique(found, seen, makeRef(match[1].toLowerCase() === 'pr' ? 'pr' : 'issue', digits.replace('#', ''), repo));
  }
  if (/\bgh\s+pr\s+(?:create|edit)\b/.test(text)) {
    for (const match of text.matchAll(CLOSING)) {
      pushUnique(found, seen, makeRef('issue', match[3], match[1] ?? match[2]));
    }
  }
  return found;
}

function* messageTexts(message: ChatMessage): Generator<string> {
  yield message.content;
  for (const call of message.toolCalls ?? []) {
    for (const value of Object.values(call.input ?? {})) {
      if (typeof value === 'string') yield value;
    }
    if (call.preview) yield call.preview;
  }
}

/**
 * The refs a transcript mentions, first seen first, capped at MAX_MENTIONED_REFS. Built once per
 * summary write rather than on every search keystroke; see summarizeSession.
 */
export function mentionedRefs(messages: readonly ChatMessage[]): GithubRef[] {
  const found: GithubRef[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const text of messageTexts(message)) {
      const refs = refsInText(text);
      if (refs.length > LISTING_THRESHOLD) continue;
      for (const ref of refs) {
        pushUnique(found, seen, ref);
        if (found.length >= MAX_MENTIONED_REFS) return found;
      }
    }
  }
  return found;
}

function repoName(repo: string): string {
  return repo.slice(repo.lastIndexOf('/') + 1);
}

/**
 * How well two repos agree: 2 when they are the same, 1 when either is unstated (a title's bare
 * `#N` names the session's own repo, which the summary does not know), 0 when they differ. A short
 * name matches the repo name it abbreviates: `docs` matches `owner/docs` and `owner/acme-docs`.
 */
function repoAgreement(a: string | undefined, b: string | undefined): 0 | 1 | 2 {
  if (!a || !b) return 1;
  if (a === b) return 2;
  if (a.includes('/') && b.includes('/')) return 0;
  const [left, right] = [repoName(a), repoName(b)];
  return left === right || left.endsWith(`-${right}`) || right.endsWith(`-${left}`) ? 2 : 0;
}

function kindsAgree(query: GithubRefKind, candidate: GithubRefKind): boolean {
  return query === 'either' || candidate === 'either' || query === candidate;
}

/** The refs one session carries, by source. Title and branch are derived here; `pr` and mentions come from main. */
export type SessionRefs = {
  title: readonly GithubRef[];
  branch: readonly GithubRef[];
  pr: readonly GithubRef[];
  mention: readonly GithubRef[];
};

export type RefMatch = {
  ref: GithubRef;
  source: GithubRefSource;
  score: number;
};

const SOURCE_WEIGHT: Record<GithubRefSource, number> = { title: 40, pr: 40, branch: 30, mention: 10 };
const SOURCE_ORDER: readonly GithubRefSource[] = ['title', 'pr', 'branch', 'mention'];

/** The best ref of `refs` matching `query`, or null. Exact repo and exact kind break ties within a source. */
export function matchRefs(query: GithubRef, refs: SessionRefs): RefMatch | null {
  let best: RefMatch | null = null;
  for (const source of SOURCE_ORDER) {
    for (const ref of refs[source]) {
      if (ref.number !== query.number || !kindsAgree(query.kind, ref.kind)) continue;
      const repo = repoAgreement(query.repo, ref.repo);
      if (repo === 0) continue;
      const kindBonus = query.kind !== 'either' && query.kind === ref.kind ? 2 : 0;
      const score = SOURCE_WEIGHT[source] + (repo === 2 ? 4 : 0) + kindBonus;
      if (!best || score > best.score) best = { ref, source, score };
    }
  }
  return best;
}

/** `PR #6526`, `Issue docs#12`, `#5710`: what a result's chip says it matched. */
export function refLabel(ref: GithubRef): string {
  const prefix = ref.kind === 'pr' ? 'PR ' : ref.kind === 'issue' ? 'Issue ' : '';
  const repo = ref.repo ? repoName(ref.repo) : '';
  return `${prefix}${repo}#${ref.number}`;
}
