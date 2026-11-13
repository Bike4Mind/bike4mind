import type { ChatApprovalMode, ChatAutomaticOrigin, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { DEFAULT_HOLD_LABELS, type LoopStageGuards } from '@shared/loopRunner';
import type { PrRef, PrSnapshot, PrMergeMethod } from '@shared/pullRequest';
import type { LoopMergePolicy } from '@bike4mind/common';
import type { AutomaticTurnResult } from '../chat/ChatService';
import type { GhRunner } from '../pr/gh';
import { mergeDecision, readLabels, runDeployCheck, runSmoke, type SmokeDeps } from './guards';

/**
 * The run path both loop runners share: LoopRunner (web loops' desktop stages) and LocalLoopScheduler (Desktop-owned
 * loops). A run is one code session in its own worktree of the loop's checkout, unattended, worked by an automatic
 * turn; its merge goes through the stage's policy.
 */

/**
 * A completions refusal at the credit cap: the run stops and the ticket goes back, never retried.
 * Matches both of completions.ts toRequestError's forms, with and without the server's body.
 */
export const CREDIT_STOP = /status 422\b/;

/** Prefixed to every run prompt: the agent otherwise went looking for the repository on disk. */
export const WORKTREE_LINE =
  "You are already in this loop's repository: a git worktree that is your shell's current directory. Work there; do not search the filesystem for the repository.";

export const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Only a call that creates a PR names the run's own PR; reads (CHANGELOGs, gh pr list) name others. */
export const opensPr = (call: ChatToolCall): boolean =>
  typeof call.input.command === 'string' && /\bgh\s+pr\s+create\b/.test(call.input.command);

/** What an approval card in a run asked for: the block reason if it goes unanswered. */
export function pendingReason(event: ChatStreamEvent): string | undefined {
  if (event.type !== 'tool-start' || event.call.status !== 'awaiting-approval') return undefined;
  const { call } = event;
  if (call.name === 'ask_user') {
    const questions = Array.isArray(call.input.questions) ? (call.input.questions as { question?: unknown }[]) : [];
    const asked = questions
      .map(question => (typeof question.question === 'string' ? question.question : ''))
      .filter(Boolean);
    return `Question: ${asked.join(' / ') || 'the agent asked for input'}`;
  }
  return `Needs approval: ${call.approvalDetail ?? call.name}`;
}

export interface LoopSessionChat {
  createCodeSession(request: {
    directory: string;
    workspace: boolean;
  }): Promise<{ ok: true; session: { id: string } } | { ok: false; error: string }>;
  setApprovalMode(sessionId: string, mode: ChatApprovalMode): Promise<unknown>;
  setLoopRunModel(sessionId: string, model: string): Promise<unknown>;
  deleteSession(sessionId: string, removeWorktree?: boolean): Promise<void>;
  startAutomaticTurn(sessionId: string, text: string, automatic: ChatAutomaticOrigin): Promise<AutomaticTurnResult>;
}

/**
 * Create the run's session: a workspace (worktree) code session in `directory`, its approval mode, then its model.
 * `failed` when the session could not be created, `released` when setting it up threw (the empty session is removed).
 */
export async function openLoopSession(
  chat: LoopSessionChat,
  options: { directory: string; approvalMode: ChatApprovalMode; model?: string }
): Promise<{ ok: true; sessionId: string } | { ok: false; outcome: 'failed' | 'released'; reason: string }> {
  let sessionId: string | undefined;
  try {
    const created = await chat.createCodeSession({ directory: options.directory, workspace: true });
    if (!created.ok) return { ok: false, outcome: 'failed', reason: created.error };
    sessionId = created.session.id;
    await chat.setApprovalMode(sessionId, options.approvalMode);
    if (options.model) await chat.setLoopRunModel(sessionId, options.model);
    return { ok: true, sessionId };
  } catch (err) {
    // No turn has run, so no worktree exists yet: only the empty conversation is left to remove.
    if (sessionId) await chat.deleteSession(sessionId).catch(() => undefined);
    return { ok: false, outcome: 'released', reason: `could not start: ${String(err)}` };
  }
}

/** Start the run's turn. Register the lane first: the turn's events start arriving before this resolves. */
export const startLoopTurn = (
  chat: Pick<LoopSessionChat, 'startAutomaticTurn'>,
  sessionId: string,
  prompt: string,
  automatic: ChatAutomaticOrigin
): Promise<AutomaticTurnResult | { ok: false; error: string }> =>
  chat
    .startAutomaticTurn(sessionId, `${WORKTREE_LINE}\n\n${prompt}`, automatic)
    .catch((err: unknown) => ({ ok: false as const, error: String(err) }));

export interface LoopMergeGithub {
  snapshot(ref: PrRef, options: { threads: boolean; queue?: boolean }): Promise<PrSnapshot>;
  merge(ref: PrRef, method: PrMergeMethod, headSha: string): Promise<void>;
  enqueue(nodeId: string, headSha: string): Promise<number>;
}

export type LoopMerged = { pr: PrRef; mergeSha?: string };

/**
 * loop_merge_pr's merge: only in the loop's own repository (the user's gh could merge a green PR anywhere it has
 * rights), only as the stage's policy and hold labels allow. A refusal's reason blocks the ticket.
 */
export async function mergeLoopPr(
  deps: { github: LoopMergeGithub; gh: GhRunner },
  ref: PrRef,
  options: { repo?: string; mergePolicy: LoopMergePolicy; holdLabels?: readonly string[] }
): Promise<{ ok: true; message: string; merged: LoopMerged } | { ok: false; reason: string }> {
  const { repo } = options;
  if (`${ref.owner}/${ref.repo}`.toLowerCase() !== repo)
    return { ok: false, reason: `${ref.url} is not in this loop's repository (${repo ?? 'unknown'}).` };

  let snapshot: PrSnapshot;
  let labels: string[];
  try {
    [snapshot, labels] = await Promise.all([
      deps.github.snapshot(ref, { threads: false, queue: true }),
      readLabels(deps.gh, ref),
    ]);
  } catch (err) {
    // Not a tool error the model could finish past: an unreadable PR is not merged, so the ticket waits.
    return { ok: false, reason: `Could not read ${ref.url}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const decision = mergeDecision(snapshot, labels, options.mergePolicy, options.holdLabels ?? DEFAULT_HOLD_LABELS);
  if (!decision.merge) return { ok: false, reason: decision.reason };
  try {
    if (decision.via === 'queue') {
      if (!snapshot.nodeId) return { ok: false, reason: 'GitHub did not give the PR id needed to enqueue it.' };
      await deps.github.enqueue(snapshot.nodeId, snapshot.headSha);
      return { ok: true, message: `Added ${ref.url} to the merge queue.`, merged: { pr: ref } };
    }
    await deps.github.merge(ref, decision.method, snapshot.headSha);
  } catch (err) {
    return { ok: false, reason: `GitHub refused the merge: ${err instanceof Error ? err.message : String(err)}` };
  }
  const view = await deps
    .gh(['pr', 'view', ref.url, '--json', 'mergeCommit'])
    .then(text => (JSON.parse(text) as { mergeCommit?: { oid?: string } | null }).mergeCommit?.oid)
    .catch(() => undefined);
  return { ok: true, message: `Merged ${ref.url}.`, merged: { pr: ref, ...(view ? { mergeSha: view } : {}) } };
}

/** After a merge: the stage's deploy workflow, then its smoke check. Either failing is the reason to block. */
export async function afterMergeChecks(
  deps: { gh: GhRunner; smoke?: SmokeDeps; now: () => number; sleep: (ms: number) => Promise<void> },
  merged: LoopMerged | undefined,
  guards: LoopStageGuards | undefined,
  directory: string,
  smokeCwd: () => Promise<string>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // No merge sha means the PR went to the merge queue, which may still drop it: wait for it to land.
  if (merged && (guards?.deployWorkflow || !merged.mergeSha)) {
    const deployed = await runDeployCheck(
      deps.gh,
      {
        pr: merged.pr,
        mergeSha: merged.mergeSha,
        ...(guards?.deployWorkflow ? { workflow: guards.deployWorkflow } : {}),
        cwd: directory,
      },
      { now: deps.now, sleep: deps.sleep }
    );
    if (!deployed.ok) return deployed;
  }
  if (merged && guards?.smoke) {
    const smoked = await runSmoke(guards.smoke, await smokeCwd(), deps.smoke);
    if (!smoked.ok) return smoked;
  }
  return { ok: true };
}
