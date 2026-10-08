/**
 * A conversation's pull request: which one it is bound to, what GitHub last said about it, and
 * what the user has asked the app to do with it.
 *
 * Everything GitHub reports here (titles, branch names, check names) is untrusted text. The
 * renderer draws it as text and never as markup; see PrStatusBar.
 */

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  /** Canonical https://github.com/<owner>/<repo>/pull/<number>, rebuilt from the parts. */
  url: string;
}

/** How a binding was made. Recorded so a later automatic detection never overrides a manual one by surprise. */
export type PrBindingSource = 'shell' | 'branch' | 'manual';

/** The automations the CI popover offers, each opt-in for this one PR. */
export type PrOption = 'autoFix' | 'autoMerge' | 'autoArchive';

/**
 * What is stored per conversation, in main's pull-requests.json. See PrBindingStore.
 *
 * The three options are consent for THIS pull request only: binding a different one starts with
 * all of them off, and nothing here is ever copied to another conversation as a default.
 */
export interface PrBinding extends PrRef {
  source: PrBindingSource;
  boundAt: string;
  /** The user closed the bar. The binding is kept so the same PR detected again stays hidden. */
  dismissed?: boolean;
  autoFix?: boolean;
  autoMerge?: boolean;
  /**
   * Who merges: GitHub's own auto-merge, armed with `gh pr merge --auto`, or this app, for a repo
   * that does not allow it. See desktopMergeReadiness for the rules the second one follows.
   */
  autoMergeMode?: 'github' | 'desktop';
  autoArchive?: boolean;
  /** Auto-fix turns started for this PR, persisted so a relaunch does not refill the budget. */
  autoFixAttempts?: number;
  /** Fingerprints of failures and comments auto-fix has already acted on. See autoFix.ts. */
  autoFixHandled?: string[];
  /** The state at the last successful read; what an auto-archive transition is measured from. */
  lastState?: PrState;
  /** Set when auto-archive has fired, so it fires once even if the user unarchives. */
  archivedOnClose?: boolean;
}

export type PrCheckBucket = 'pending' | 'pass' | 'fail' | 'skipped';

export interface PrCheck {
  name: string;
  bucket: PrCheckBucket;
  required: boolean;
  url?: string;
  workflow?: string;
}

export type PrMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type PrMergeMethod = 'squash' | 'merge' | 'rebase';

export interface PrRepoSettings {
  autoMergeAllowed: boolean;
  allowedMethods: PrMergeMethod[];
  /** GitHub's own default for this viewer, when it is one of the allowed methods. */
  defaultMethod?: PrMergeMethod;
}

/** One unresolved review thread, reduced to its latest comment. Only read while auto-fix is on. */
export interface PrReviewThread {
  id: string;
  path?: string;
  line?: number;
  commentId: number;
  author: string;
  /** GitHub's authorAssociation: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ... */
  association: string;
  body: string;
  url: string;
  outdated: boolean;
}

/**
 * A reviewer's latest review, when it requests changes. Often the whole request lives in its
 * body with no inline threads at all. Only read while auto-fix is on.
 */
export interface PrChangeRequest {
  reviewId: number;
  author: string;
  association: string;
  body: string;
  url: string;
}

/** One read of a pull request. Never stored; main holds the latest in memory. */
export interface PrSnapshot extends PrRef {
  title: string;
  author: string;
  state: PrState;
  isDraft: boolean;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  mergeable: PrMergeable;
  /** GitHub's mergeStateStatus: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  mergeStateStatus: string;
  reviewDecision: PrReviewDecision;
  autoMergeArmed: boolean;
  checks: PrCheck[];
  repoSettings: PrRepoSettings;
  viewer: string;
  /** Present only when the read asked for threads, which it does only while auto-fix is on. */
  threads?: PrReviewThread[];
  /** Read with the threads, for the same reason. */
  changeRequests?: PrChangeRequest[];
  fetchedAt: number;
}

/** Whether `gh` can be used at all. Anything but 'ok' replaces the bar's content with a fix-it line. */
export type PrGhStatus = 'ok' | 'missing' | 'unauthenticated';

export type PrAutoFixStatus = 'off' | 'watching' | 'waiting' | 'started' | 'exhausted';

/** Everything the bar draws for one conversation, pushed main -> renderer on every change. */
export interface PrBarState {
  sessionId: string;
  /** Null when the conversation has no PR, or the user dismissed it: no bar. */
  binding: PrBinding | null;
  /** Null until the first read lands. */
  snapshot: Omit<PrSnapshot, 'threads' | 'changeRequests'> | null;
  gh: PrGhStatus;
  /** The last read's failure, one line, while it is still the latest word. */
  error?: string;
  refreshing: boolean;
  /** How the bar says what auto-merge is doing: armed on GitHub, or held by this app. */
  autoMerge: { mode: 'github' | 'desktop' | null; note?: string };
  autoFix: { status: PrAutoFixStatus; attempts: number; max: number; note?: string };
}

export type PrActionResult = { ok: true } | { ok: false; error: string };

const PR_URL_PATTERN = /https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?![\d/]*new\b)/g;

function toRef(owner: string, repo: string, number: number): PrRef {
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

/**
 * A pull request URL, or null. Tolerates a trailing path (`/files`, `/checks`), a query or a
 * fragment, because that is what a URL copied from the browser carries.
 */
export function parsePullRequestUrl(text: string): PrRef | null {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
    text.trim()
  );
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return toRef(match[1], match[2], number);
}

/**
 * Every PR URL in some command output, in order. `/pull/new/<branch>` - what a first `git push`
 * prints - is a link to CREATE one and is skipped, which the pattern's lookahead does.
 */
export function findPullRequestUrls(text: string): PrRef[] {
  const found: PrRef[] = [];
  for (const match of text.matchAll(PR_URL_PATTERN)) {
    const number = Number(match[3]);
    if (Number.isSafeInteger(number) && number > 0) found.push(toRef(match[1], match[2], number));
  }
  return found;
}

/**
 * Only output from these commands binds a conversation. Any other command printing a PR URL -
 * `gh pr list`, a `curl`, a `cat` of a changelog - is the agent reading about a PR, not opening one.
 */
const BINDING_COMMAND = /(^|[\s;&|(])(gh\s+pr\s+create|git\s+push)\b/;

/** The PR a shell command's output announces, or null. The last URL wins: it is the one printed on completion. */
export function pullRequestFromShell(command: string, output: string): PrRef | null {
  if (!BINDING_COMMAND.test(command)) return null;
  const urls = findPullRequestUrls(output);
  return urls.length > 0 ? urls[urls.length - 1] : null;
}

export function samePullRequest(a: PrRef | null | undefined, b: PrRef | null | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.number === b.number &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

export interface PrCheckCounts {
  pending: number;
  pass: number;
  fail: number;
  skipped: number;
}

export function countChecks(checks: readonly PrCheck[]): PrCheckCounts {
  const counts: PrCheckCounts = { pending: 0, pass: 0, fail: 0, skipped: 0 };
  for (const check of checks) counts[check.bucket] += 1;
  return counts;
}

/** The one colour the CI dot takes: any failure outranks anything running, which outranks a pass. */
export function ciSummary(checks: readonly PrCheck[]): 'none' | 'pending' | 'pass' | 'fail' {
  if (checks.length === 0) return 'none';
  const counts = countChecks(checks);
  if (counts.fail > 0) return 'fail';
  if (counts.pending > 0) return 'pending';
  return 'pass';
}
