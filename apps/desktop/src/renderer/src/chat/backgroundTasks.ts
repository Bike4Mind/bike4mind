import { useEffect, useState } from 'react';
import type { BackgroundProcessStatus, ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import type { BackgroundProcessView } from './useBackgroundProcesses';

/**
 * The count chip above the composer.
 *
 * Zero takes the plural ("0 running tasks") rather than a special case, but the chip is not
 * drawn at zero at all, so that branch only ever shows up in a test.
 */
export function runningTasksLabel(running: number): string {
  return `${running} running ${running === 1 ? 'task' : 'tasks'}`;
}

interface TaskTiming {
  startedAt: string;
  endedAt?: string;
}

/**
 * How long a task has been going, or how long it ran.
 *
 * A finished task is frozen at its own end: reading `now` for one would make every card in the
 * Finished list tick upwards forever. An unparseable timestamp yields 0 rather than NaN, which
 * would otherwise render as "NaNs".
 */
export function taskElapsedMs(entry: TaskTiming, now: number): number {
  const started = Date.parse(entry.startedAt);
  if (Number.isNaN(started)) return 0;
  const ended = entry.endedAt === undefined ? Number.NaN : Date.parse(entry.endedAt);
  return Math.max(0, (Number.isNaN(ended) ? now : ended) - started);
}

/**
 * One line to head a task card.
 *
 * The first line only: a background command is often a heredoc or an `&&` chain several lines
 * long, and a card that grows to fit one pushes the rest of the list off screen.
 */
export function taskTitle(command: string): string {
  const firstLine = command.split('\n', 1)[0].trim();
  return firstLine || 'command';
}

export function taskStatusLabel(entry: BackgroundProcessView): string {
  if (entry.status === 'killed') return 'stopped';
  if (entry.status === 'failed') return 'failed';
  if (entry.exitCode !== null && entry.exitCode !== undefined) return `exit ${entry.exitCode}`;
  return entry.signal ?? 'exited';
}

/** The two sections of the panel, each in the order main reported them. */
export function splitTasks<T extends { status: BackgroundProcessStatus }>(
  processes: readonly T[]
): { running: T[]; finished: T[] } {
  return {
    running: processes.filter(entry => entry.status === 'running'),
    finished: processes.filter(entry => entry.status !== 'running'),
  };
}

/**
 * A clock for an elapsed column, and nothing else.
 *
 * Deliberately scoped to the component that draws the column: the same per-second `setState` hung
 * off the shell would re-render the whole transcript once a second. It idles when nothing is
 * running, so a list of finished tasks costs nothing at all.
 */
export function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}

/** A session the agent spawned from the open one, as the session panel lists it. */
export interface SpawnedSessionView {
  id: string;
  title: string;
  createdAt: string;
  /** Main's status for it; absent until main has reported one, which reads as not running. */
  status: ChatSessionStatus | undefined;
}

export function isSpawnedRunning(entry: SpawnedSessionView): boolean {
  return entry.status === 'processing' || entry.status === 'needs-action';
}

/**
 * The open conversation's direct children, newest first. Grandchildren belong to the child that
 * spawned them, and listing them here would offer a Stop for work this conversation never started.
 */
export function spawnedSessions(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  parentId: string | null
): SpawnedSessionView[] {
  if (!parentId) return [];
  return sessions
    .filter(session => session.origin?.parentSessionId === parentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(session => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      status: statuses.get(session.id),
    }));
}

/**
 * Whether the task panel is showing, and whether it is at its wider size.
 *
 * Per-machine window chrome, so localStorage and not the session file: which panes a user keeps
 * open is a property of the screen they are sitting at, not of the conversation. Both default
 * to off - the panel has to be asked for, via the chip, before it takes any width.
 */
const PANEL_FLAG_KEYS = {
  open: 'b4m.backgroundTasks.open',
  wide: 'b4m.backgroundTasks.wide',
} as const;

export type PanelFlag = keyof typeof PANEL_FLAG_KEYS;

export function readPanelFlag(flag: PanelFlag): boolean {
  try {
    return window.localStorage.getItem(PANEL_FLAG_KEYS[flag]) === '1';
  } catch {
    // Storage blocked. Closed for this run, which is the default anyway.
    return false;
  }
}

export function writePanelFlag(flag: PanelFlag, value: boolean): void {
  try {
    window.localStorage.setItem(PANEL_FLAG_KEYS[flag], value ? '1' : '0');
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a click.
  }
}
