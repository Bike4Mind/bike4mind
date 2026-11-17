import { useEffect, useState } from 'react';
import type { ChildOutcome } from '@shared/agentOutcome';
import type { AgentState, AgentView } from '../roster';

/** How long (ms) a finished quest stays checked off on the board before it is taken down. */
export const QUEST_DONE_LINGER_MS = 8000;

/** States in which an agent's quest is still open and pinned to the board. */
const OPEN: ReadonlySet<AgentState> = new Set<AgentState>(['working', 'needs-you']);

/** `finishedAt` (ms) is set on a done note, so its fade keeps the take-down's clock however late it mounts. */
export type QuestNote = { agent: AgentView; done: boolean; finishedAt?: number };

/**
 * The quest an agent is on, short enough for a note: the first line of its task contract's outcome
 * when it was spawned with one, otherwise its session title.
 */
export function questTitle(agent: AgentView): string {
  const outcome = agent.workerTask?.contract.outcome.trim().split('\n')[0]?.trim();
  return outcome || agent.title;
}

/** What the board remembers between roster updates. */
export type QuestLedger = {
  /** Agents seen on an open quest that has not yet ended, with their record as last seen open. */
  open: ReadonlyMap<string, OpenSnapshot>;
  /** When each agent seen finishing did so (ms). */
  finished: ReadonlyMap<string, number>;
};

/**
 * The session record as last seen on an open quest: until it changes, any stored outcome is a previous
 * run's. Only a run last seen in-run can be in that gap: a live approval mid-run still is, but a task
 * waiting on the user in its Task panel holds its own outcome, so what it turns into next is real.
 */
type OpenSnapshot = { outcome: ChildOutcome | undefined; updatedAt: string; inRun: boolean };

/** Working, or `needs-you` on a live approval (no task, or one still queued/running) rather than a Task panel wait. */
function isInRun(agent: AgentView): boolean {
  if (agent.state === 'working') return true;
  if (agent.state !== 'needs-you') return false;
  const status = agent.workerTask?.state.status;
  return status === undefined || status === 'queued' || status === 'running';
}

export const EMPTY_LEDGER: QuestLedger = { open: new Map(), finished: new Map() };

/**
 * Whether a no-longer-open agent is only between its run ending and that run's outcome being stored.
 * Its live status clears first, so for a moment it reads as its previous outcome (idle on a first run,
 * failed or stopped on a re-run). The stored outcome lands with a record update, which ends the bridge.
 */
function isAwaitingOutcome(agent: AgentView, snapshot: OpenSnapshot): boolean {
  if (!snapshot.inRun || agent.outcome !== snapshot.outcome) return false;
  return agent.updatedAt === snapshot.updatedAt || (agent.state === 'idle' && agent.outcome === undefined);
}

/** A re-run reading `done` from the previous run's stored outcome, before the new outcome lands. */
function isStaleDone(agent: AgentView, snapshot: OpenSnapshot): boolean {
  return (
    snapshot.inRun &&
    agent.outcome !== undefined &&
    agent.outcome === snapshot.outcome &&
    agent.updatedAt === snapshot.updatedAt
  );
}

/**
 * Folds a roster update into the ledger. An agent on an open quest that later turns `done` is checked
 * off at `now`, unless it is a re-run still reading its previous outcome (see isStaleDone). Failing, stopping or ending with no reply
 * ends the quest unchecked, and an agent already done when first seen is never added, so a reload
 * does not pin up quests that finished while nobody was looking.
 */
export function trackQuests(ledger: QuestLedger, agents: readonly AgentView[], now: number): QuestLedger {
  const open = new Map<string, OpenSnapshot>();
  const finished = new Map<string, number>();
  for (const agent of agents) {
    if (OPEN.has(agent.state)) {
      open.set(agent.id, { outcome: agent.outcome, updatedAt: agent.updatedAt, inRun: isInRun(agent) });
      continue;
    }
    if (agent.state === 'done') {
      const snapshot = ledger.open.get(agent.id);
      if (!ledger.finished.has(agent.id) && snapshot && isStaleDone(agent, snapshot)) {
        open.set(agent.id, snapshot);
        continue;
      }
      const at = ledger.finished.get(agent.id) ?? (snapshot ? now : undefined);
      if (at !== undefined) finished.set(agent.id, at);
      continue;
    }
    const snapshot = ledger.open.get(agent.id);
    if (snapshot && isAwaitingOutcome(agent, snapshot)) open.set(agent.id, snapshot);
  }
  return { open, finished };
}

/** Drops quests that have been checked off for at least QUEST_DONE_LINGER_MS. */
export function takeDown(finished: ReadonlyMap<string, number>, now: number): Map<string, number> {
  return new Map([...finished].filter(([, at]) => now - at < QUEST_DONE_LINGER_MS));
}

/** Notes in roster order: every open quest, including one on its way to done, and each finished one while it lingers. */
export function questNotes(agents: readonly AgentView[], ledger: QuestLedger): QuestNote[] {
  return agents.flatMap((agent): QuestNote[] => {
    if (ledger.open.has(agent.id)) return [{ agent, done: false }];
    const finishedAt = ledger.finished.get(agent.id);
    if (agent.state === 'done' && finishedAt !== undefined) return [{ agent, done: true, finishedAt }];
    return [];
  });
}

/** The board's notes, checking quests off as their agents finish and taking them down after a while. */
export function useQuestNotes(agents: readonly AgentView[]): QuestNote[] {
  const [tracked, setTracked] = useState(() => ({ agents, ledger: trackQuests(EMPTY_LEDGER, agents, Date.now()) }));
  // Derived during render (not in an effect) so a finishing quest is never drawn missing for a frame.
  if (tracked.agents !== agents) {
    setTracked({ agents, ledger: trackQuests(tracked.ledger, agents, Date.now()) });
  }
  const { ledger } = tracked;
  const { finished } = ledger;
  useEffect(() => {
    if (finished.size === 0) return;
    const due = Math.min(...finished.values()) + QUEST_DONE_LINGER_MS;
    const timer = window.setTimeout(
      () =>
        setTracked(current => ({
          ...current,
          ledger: { ...current.ledger, finished: takeDown(current.ledger.finished, Date.now()) },
        })),
      Math.max(0, due - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [finished]);
  return questNotes(agents, ledger);
}
