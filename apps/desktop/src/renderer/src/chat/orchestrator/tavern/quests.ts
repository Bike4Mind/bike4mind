import { useEffect, useState } from 'react';
import type { AgentState, AgentView } from '../roster';

/** How long (ms) a finished quest stays checked off on the board before it is taken down. */
export const QUEST_DONE_LINGER_MS = 8000;

/** States in which an agent's quest is still open and pinned to the board. */
const OPEN: ReadonlySet<AgentState> = new Set<AgentState>(['working', 'needs-you']);

export type QuestNote = { agent: AgentView; done: boolean };

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
  /** Agents seen on an open quest that has not yet ended. */
  open: ReadonlySet<string>;
  /** When each agent seen finishing did so (ms). */
  finished: ReadonlyMap<string, number>;
};

export const EMPTY_LEDGER: QuestLedger = { open: new Set(), finished: new Map() };

/**
 * Folds a roster update into the ledger. An agent on an open quest that later turns `done` is checked
 * off at `now`, even across an `idle` in between: when a run ends its live status clears before its
 * stored outcome arrives, so it reads idle for a moment. Failing, stopping or ending with no reply
 * ends the quest unchecked, and an agent already done when first seen is never added, so a reload
 * does not pin up quests that finished while nobody was looking.
 */
export function trackQuests(ledger: QuestLedger, agents: readonly AgentView[], now: number): QuestLedger {
  const open = new Set<string>();
  const finished = new Map<string, number>();
  for (const agent of agents) {
    if (OPEN.has(agent.state)) {
      open.add(agent.id);
      continue;
    }
    if (agent.state === 'done') {
      const at = ledger.finished.get(agent.id) ?? (ledger.open.has(agent.id) ? now : undefined);
      if (at !== undefined) finished.set(agent.id, at);
      continue;
    }
    // No stored outcome yet: the run just ended and is on its way to done. A no-reply end has one.
    if (agent.state === 'idle' && agent.outcome === undefined && ledger.open.has(agent.id)) open.add(agent.id);
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
    if (agent.state === 'done' && ledger.finished.has(agent.id)) return [{ agent, done: true }];
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
