import { awaitsWorktree, type ChatProject, type ChatStreamEvent } from '@shared/chat';

/** A first turn waiting on its worktree, for the status line under the transcript. */
export interface WorkspaceProgress {
  /** Epoch ms the wait began, for the elapsed clock. */
  since: number;
  base: string;
  /** The session's own branch, once main has chosen it. */
  branch?: string;
}

type WorkspaceEvent = Extract<ChatStreamEvent, { type: 'workspace' }>;

/**
 * What a send shows before main has said anything, so the line is there on the keystroke.
 *
 * Null on every turn after the first: by then the session is in its worktree, and drawing this
 * for a field comparison main skips in microseconds would flash a step that is not happening.
 */
export function preparingOnSend(
  project: ChatProject | undefined,
  streaming: boolean,
  now: number
): WorkspaceProgress | null {
  if (streaming || !project || !awaitsWorktree(project)) return null;
  return { since: now, base: project.branch };
}

/**
 * Fold main's report in.
 *
 * `sending` holds the line past `running: false` while this window's own send is still out: the
 * turn's 'start', or the refusal, follows within the same call and takes over from it, and
 * clearing here first would blink the status line off between the two.
 */
export function applyWorkspaceEvent(
  current: WorkspaceProgress | null,
  event: WorkspaceEvent,
  now: number,
  sending: boolean
): WorkspaceProgress | null {
  if (!event.running) return sending ? current : null;
  const branch = event.branch ?? current?.branch;
  return { since: current?.since ?? now, base: event.base, ...(branch ? { branch } : {}) };
}

export function workspacePhrase(progress: WorkspaceProgress): string {
  if (progress.branch) return `Creating branch ${progress.branch} and worktree...`;
  return progress.base ? `Preparing worktree on ${progress.base}...` : 'Preparing worktree...';
}
