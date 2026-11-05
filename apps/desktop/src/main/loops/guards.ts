import { exec } from 'node:child_process';
import type { PrMergeMethod, PrRef, PrSnapshot } from '@shared/pullRequest';
import { DEFAULT_HOLD_LABELS, type LoopMergePolicy, type LoopSmokeCheck } from '@shared/loopRunner';
import { SET_SESSION_PULL_REQUEST_TOOL_NAME } from '../chat/tools/pullRequestTool';
import { desktopMergeReadiness } from '../pr/autoMerge';
import { SHELL_TOOLS, shellGuardViolation } from '../pr/autoFix';
import type { GhRunner } from '../pr/gh';

export const LOOP_MERGE_TOOL_NAME = 'loop_merge_pr';

/**
 * Why a tool call is refused in a loop runner session, or null. Like auto-fix's guard, minus the
 * ban on session_spawn/session_send: a spawned child inherits the runner marking (and this guard)
 * in ChatService, so delegating cannot get around it.
 */
export function loopRunnerToolRefusal(name: string, input: Record<string, unknown>): string | null {
  if (name === SET_SESSION_PULL_REQUEST_TOOL_NAME)
    return 'A loop runner turn may not change which PR this session follows.';
  if (!SHELL_TOOLS.has(name)) return null;
  const violation = shellGuardViolation(typeof input.command === 'string' ? input.command : '');
  if (violation === 'force-push') return 'A loop runner turn may not force-push. Push a new commit on top instead.';
  if (violation === 'merge') return `A loop runner turn may not merge from the shell; call ${LOOP_MERGE_TOOL_NAME}.`;
  return null;
}

/** `owner/name` from an origin URL (https or ssh), lower-cased, or null. */
export function repoSlug(remote: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

export type MergeDecision =
  | { merge: true; via: 'queue' }
  | { merge: true; via: 'merge'; method: PrMergeMethod }
  | { merge: false; reason: string };

/**
 * Whether loop_merge_pr may merge this PR under the stage's policy. Hold labels and every CI,
 * draft and mergeability check apply in every mode; only 'review' also needs an approval.
 */
export function mergeDecision(
  snapshot: PrSnapshot,
  labels: readonly string[],
  policy: LoopMergePolicy,
  holdLabels: readonly string[] = DEFAULT_HOLD_LABELS
): MergeDecision {
  if (policy === 'never') return { merge: false, reason: 'awaiting human merge' };
  const holds = new Set(holdLabels.map(label => label.toLowerCase()));
  const held = labels.find(label => holds.has(label.toLowerCase()));
  if (held) return { merge: false, reason: `The pull request has the "${held}" label.` };
  const readiness = desktopMergeReadiness(snapshot, { requireReview: policy === 'review' });
  if (!readiness.ready) return { merge: false, reason: readiness.reason };
  const { ready: _ready, ...how } = readiness;
  return { merge: true, ...how };
}

/** The labels on a PR, through the user's own gh. */
export async function readLabels(gh: GhRunner, ref: PrRef): Promise<string[]> {
  const stdout = await gh(['pr', 'view', ref.url, '--json', 'labels']);
  const parsed = JSON.parse(stdout) as { labels?: { name?: unknown }[] };
  return (parsed.labels ?? []).map(label => (typeof label.name === 'string' ? label.name : '')).filter(Boolean);
}

export interface WaitDeps {
  sleep(ms: number): Promise<void>;
  now(): number;
  signal?: AbortSignal;
}

export type CheckResult = { ok: true } | { ok: false; reason: string };

const DEPLOY_POLL_MS = 30_000;
export const DEPLOY_TIMEOUT_MS = 60 * 60_000;

/**
 * Wait for the PR's merge commit (a merge queue lands it later), then for `workflow`'s run on it
 * to conclude. Anything but success, or no conclusion within `timeoutMs`, fails. With no
 * `workflow`, passes as soon as the PR has merged.
 */
export async function runDeployCheck(
  gh: GhRunner,
  target: { pr: PrRef; mergeSha?: string; workflow?: string; cwd: string },
  deps: WaitDeps,
  timeoutMs = DEPLOY_TIMEOUT_MS
): Promise<CheckResult> {
  const deadline = deps.now() + timeoutMs;
  let sha = target.mergeSha;
  while (deps.now() < deadline && !deps.signal?.aborted) {
    if (!sha) {
      const view = JSON.parse(await gh(['pr', 'view', target.pr.url, '--json', 'state,mergeCommit'])) as {
        state?: string;
        mergeCommit?: { oid?: string } | null;
      };
      if (view.state === 'CLOSED')
        return {
          ok: false,
          reason: `${target.workflow ? 'deploy did not reach prod: ' : ''}the PR was closed unmerged`,
        };
      if (view.state === 'MERGED' && view.mergeCommit?.oid) sha = view.mergeCommit.oid;
    }
    if (sha) {
      if (!target.workflow) return { ok: true };
      const runs = JSON.parse(
        await gh(
          [
            'run',
            'list',
            '--commit',
            sha,
            '--workflow',
            target.workflow,
            '--json',
            'status,conclusion,url',
            '--limit',
            '1',
          ],
          { cwd: target.cwd }
        )
      ) as { status?: string; conclusion?: string; url?: string }[];
      const run = runs[0];
      if (run?.status === 'completed') {
        return run.conclusion === 'success'
          ? { ok: true }
          : {
              ok: false,
              reason: `deploy did not reach prod: ${target.workflow} ${run.conclusion ?? 'failed'} (${run.url ?? ''})`,
            };
      }
    }
    await deps.sleep(DEPLOY_POLL_MS);
  }
  const minutes = timeoutMs / 60_000;
  return {
    ok: false,
    reason: target.workflow
      ? `deploy did not reach prod: ${target.workflow} did not finish within ${minutes} min`
      : `the PR did not merge from the merge queue within ${minutes} min`,
  };
}

const SMOKE_TIMEOUT_MS = 5 * 60_000;

export interface SmokeDeps {
  fetch(url: string, init: { signal: AbortSignal }): Promise<{ status: number }>;
  run(command: string, cwd: string, timeoutMs: number): Promise<void>;
}

export const realSmokeDeps: SmokeDeps = {
  fetch: (url, init) => fetch(url, init),
  run: (command, cwd, timeoutMs) =>
    new Promise((resolve, reject) => {
      exec(command, { cwd, timeout: timeoutMs }, error => (error ? reject(error) : resolve()));
    }),
};

export async function runSmoke(
  smoke: LoopSmokeCheck,
  cwd: string,
  deps: SmokeDeps = realSmokeDeps
): Promise<CheckResult> {
  try {
    if ('url' in smoke) {
      const response = await deps.fetch(smoke.url, { signal: AbortSignal.timeout(60_000) });
      if (response.status >= 200 && response.status < 300) return { ok: true };
      return { ok: false, reason: `smoke check failed: ${smoke.url} answered ${response.status}` };
    }
    await deps.run(smoke.command, cwd, SMOKE_TIMEOUT_MS);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `smoke check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
