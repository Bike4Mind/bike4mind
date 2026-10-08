import type {
  PrCheck,
  PrCheckBucket,
  PrMergeable,
  PrMergeMethod,
  PrRef,
  PrReviewDecision,
  PrReviewThread,
  PrSnapshot,
  PrState,
} from '@shared/pullRequest';
import { GhError, type GhRunner } from './gh';

/**
 * One query per read: the PR, its head commit's checks (with whether each is required), the
 * repo's merge settings and the viewer. Review threads ride along only while auto-fix is on,
 * because they are the expensive part and nothing else reads them.
 */
const SNAPSHOT_QUERY = `query($owner: String!, $name: String!, $number: Int!, $threads: Boolean!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerDefaultMergeMethod
    pullRequest(number: $number) {
      number title url state isDraft
      author { login }
      headRefName headRefOid baseRefName additions deletions
      mergeable mergeStateStatus reviewDecision
      autoMergeRequest { enabledAt }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number)
          checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
      } } } } } }
      reviewThreads(first: 50) @include(if: $threads) { nodes { id isResolved isOutdated path line
        comments(last: 1) { nodes { databaseId author { login } authorAssociation body url } } } }
    }
  }
}`;

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === 'object' ? (value as Json) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nodes(value: unknown): Json[] {
  const list = obj(value).nodes;
  return Array.isArray(list) ? list.map(obj) : [];
}

const FAILING_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
const SKIPPED_CONCLUSIONS = new Set(['SKIPPED', 'NEUTRAL']);

/** A check run or a commit status, in the four buckets the popover counts. */
export function checkBucket(node: Json): PrCheckBucket {
  if (node.__typename === 'StatusContext') {
    const state = str(node.state);
    if (state === 'SUCCESS') return 'pass';
    if (state === 'FAILURE' || state === 'ERROR') return 'fail';
    return 'pending';
  }
  const status = str(node.status);
  if (status !== 'COMPLETED') return 'pending';
  const conclusion = str(node.conclusion);
  if (conclusion === 'SUCCESS') return 'pass';
  if (FAILING_CONCLUSIONS.has(conclusion)) return 'fail';
  if (SKIPPED_CONCLUSIONS.has(conclusion)) return 'skipped';
  return 'pending';
}

function toCheck(node: Json): PrCheck {
  const status = node.__typename === 'StatusContext';
  const url = str(status ? node.targetUrl : node.detailsUrl);
  const workflow = str(obj(obj(obj(node.checkSuite).workflowRun).workflow).name);
  return {
    name: str(status ? node.context : node.name) || 'check',
    bucket: checkBucket(node),
    required: node.isRequired === true,
    ...(url ? { url } : {}),
    ...(workflow ? { workflow } : {}),
  };
}

function toThread(node: Json): PrReviewThread | null {
  if (node.isResolved === true) return null;
  const latest = nodes(node.comments)[0];
  if (!latest) return null;
  const line = num(node.line);
  const path = str(node.path);
  return {
    id: str(node.id),
    ...(path ? { path } : {}),
    ...(line ? { line } : {}),
    commentId: num(latest.databaseId),
    author: str(obj(latest.author).login),
    association: str(latest.authorAssociation),
    body: str(latest.body),
    url: str(latest.url),
    outdated: node.isOutdated === true,
  };
}

const METHOD_ORDER: PrMergeMethod[] = ['squash', 'merge', 'rebase'];

function parseState(value: unknown): PrState {
  return value === 'MERGED' || value === 'CLOSED' ? value : 'OPEN';
}

function parseMergeable(value: unknown): PrMergeable {
  return value === 'MERGEABLE' || value === 'CONFLICTING' ? value : 'UNKNOWN';
}

function parseReviewDecision(value: unknown): PrReviewDecision {
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED' ? value : null;
}

/** The GraphQL response, as a snapshot. Exported for tests, which feed it recorded shapes. */
export function parseSnapshot(ref: PrRef, raw: unknown, now: number, withThreads: boolean): PrSnapshot {
  const data = obj(obj(raw).data);
  const repository = obj(data.repository);
  const pr = obj(repository.pullRequest);
  if (!pr.number) throw new GhError('not-found', `#${ref.number} was not found in ${ref.owner}/${ref.repo}`);

  const allowed = {
    squash: repository.squashMergeAllowed === true,
    merge: repository.mergeCommitAllowed === true,
    rebase: repository.rebaseMergeAllowed === true,
  };
  const allowedMethods = METHOD_ORDER.filter(method => allowed[method]);
  const viewerDefault = str(repository.viewerDefaultMergeMethod).toLowerCase() as PrMergeMethod;
  const rollup = obj(obj(obj(nodes(pr.commits)[0]).commit).statusCheckRollup);

  return {
    ...ref,
    title: str(pr.title),
    author: str(obj(pr.author).login),
    state: parseState(pr.state),
    isDraft: pr.isDraft === true,
    headRefName: str(pr.headRefName),
    headSha: str(pr.headRefOid),
    baseRefName: str(pr.baseRefName),
    additions: num(pr.additions),
    deletions: num(pr.deletions),
    mergeable: parseMergeable(pr.mergeable),
    mergeStateStatus: str(pr.mergeStateStatus) || 'UNKNOWN',
    reviewDecision: parseReviewDecision(pr.reviewDecision),
    autoMergeArmed: pr.autoMergeRequest !== null && typeof pr.autoMergeRequest === 'object',
    checks: nodes(rollup.contexts).map(toCheck),
    repoSettings: {
      autoMergeAllowed: repository.autoMergeAllowed === true,
      allowedMethods,
      ...(allowedMethods.includes(viewerDefault) ? { defaultMethod: viewerDefault } : {}),
    },
    viewer: str(obj(data.viewer).login),
    ...(withThreads ? { threads: nodes(pr.reviewThreads).flatMap(node => toThread(node) ?? []) } : {}),
    fetchedAt: now,
  };
}

/** The repo's merge method this app uses: GitHub's default for the viewer, else the first allowed. */
export function mergeMethodFor(snapshot: Pick<PrSnapshot, 'repoSettings'>): PrMergeMethod | null {
  return snapshot.repoSettings.defaultMethod ?? snapshot.repoSettings.allowedMethods[0] ?? null;
}

/**
 * Everything this app asks GitHub, through `gh`. No call here passes `--admin`, and none can
 * be made to: the arguments are fixed in each method, with only the PR reference and the
 * repo's own merge method filled in.
 */
export class PrGithub {
  constructor(
    private readonly gh: GhRunner,
    private readonly now: () => number = Date.now
  ) {}

  async snapshot(ref: PrRef, options: { threads: boolean }): Promise<PrSnapshot> {
    const stdout = await this.gh([
      'api',
      'graphql',
      '-f',
      `query=${SNAPSHOT_QUERY}`,
      // -f, not -F, for the names: -F would turn a repo called "123" into a number.
      '-f',
      `owner=${ref.owner}`,
      '-f',
      `name=${ref.repo}`,
      '-F',
      `number=${ref.number}`,
      '-F',
      `threads=${options.threads}`,
    ]);
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new GhError('failed', 'GitHub returned something that is not JSON');
    }
    return parseSnapshot(ref, raw, this.now(), options.threads);
  }

  /** The open PR whose head is `branch` in the repo at `cwd`, or null. */
  async findOpenForBranch(cwd: string, branch: string): Promise<string | null> {
    const stdout = await this.gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'], {
      cwd,
    });
    try {
      const list = JSON.parse(stdout) as unknown;
      const first = Array.isArray(list) ? obj(list[0]) : {};
      return str(first.url) || null;
    } catch {
      return null;
    }
  }

  /** Arm GitHub's own auto-merge, which then enforces branch protection and required reviews itself. */
  async enableAutoMerge(ref: PrRef, method: PrMergeMethod): Promise<void> {
    await this.gh(['pr', 'merge', ref.url, '--auto', `--${method}`]);
  }

  async disableAutoMerge(ref: PrRef): Promise<void> {
    await this.gh(['pr', 'merge', ref.url, '--disable-auto']);
  }

  /**
   * Merge now. `--match-head-commit` pins the merge to the commit the readiness check looked at,
   * so a push landing between the read and this call makes GitHub refuse rather than merge
   * code nobody evaluated.
   */
  async merge(ref: PrRef, method: PrMergeMethod, headSha: string): Promise<void> {
    await this.gh(['pr', 'merge', ref.url, `--${method}`, '--match-head-commit', headSha]);
  }
}
