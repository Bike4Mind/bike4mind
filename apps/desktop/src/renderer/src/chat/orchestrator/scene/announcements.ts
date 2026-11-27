import { useEffect, useRef, useState } from 'react';
import type { AgentState, AgentView } from '../roster';

/** How long (ms) the room waits for things to settle before speaking, so a burst becomes one message. */
export const ANNOUNCE_DEBOUNCE_MS = 1500;
/** Spoken one by one; past this, the rest are folded into a count. */
const ANNOUNCE_MAX = 3;

const ARRIVALS: Partial<Record<AgentState, (name: string) => string>> = {
  'needs-you': name => `${name} needs you`,
  done: name => `${name} finished`,
  failed: name => `${name} failed`,
};

/** What a screen reader hears when an agent moves into `to`; nothing for routine moves like starting work. */
export function stateAnnouncement(name: string, from: AgentState, to: AgentState): string | undefined {
  return from === to ? undefined : ARRIVALS[to]?.(name);
}

export function joinAnnouncements(messages: readonly string[]): string {
  const spoken = messages.slice(0, ANNOUNCE_MAX);
  const rest = messages.length - spoken.length;
  return `${spoken.join('. ')}${rest > 0 ? `. ${rest} more ${rest === 1 ? 'update' : 'updates'}` : ''}.`;
}

/**
 * The text for the scene's polite live region: the transitions worth interrupting for, gathered until
 * the roster has been quiet for `debounceMs`. Agents present at mount are taken as already known.
 */
export function useAgentAnnouncements(
  agents: readonly AgentView[],
  nameOf: (agent: AgentView) => string,
  debounceMs: number = ANNOUNCE_DEBOUNCE_MS
): { key: number; text: string } {
  // Keyed by flush so a repeat of the same text still changes the DOM and is spoken again.
  const [spoken, setSpoken] = useState({ key: 0, text: '' });
  const known = useRef<Map<string, AgentState> | null>(null);
  // Keyed by agent so one that flips twice in a burst is spoken once, in its latest state.
  const pending = useRef(new Map<string, string>());
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const previous = known.current;
    known.current = new Map(agents.map(agent => [agent.id, agent.state]));
    if (!previous) return;
    let changed = false;
    for (const agent of agents) {
      // An agent that first shows up already needing you or failed is news; one that arrives done is not.
      const from = previous.get(agent.id) ?? (agent.state === 'done' ? 'done' : 'idle');
      if (from === agent.state) continue;
      const text = stateAnnouncement(nameOf(agent), from, agent.state);
      const before = pending.current.get(agent.id);
      if (text) pending.current.set(agent.id, text);
      else pending.current.delete(agent.id);
      if (pending.current.get(agent.id) !== before) changed = true;
    }
    for (const id of pending.current.keys()) {
      if (!known.current.has(id)) {
        pending.current.delete(id);
        changed = true;
      }
    }
    // Only a change to what will be spoken restarts the wait: activity ticks and silent moves must not
    // keep pushing a pending message back.
    if (!changed) return;
    window.clearTimeout(timer.current);
    if (pending.current.size === 0) return;
    timer.current = window.setTimeout(() => {
      const text = joinAnnouncements([...pending.current.values()]);
      pending.current.clear();
      setSpoken(last => ({ key: last.key + 1, text }));
    }, debounceMs);
  }, [agents, nameOf, debounceMs]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return spoken;
}
