import { useEffect, useRef } from 'react';
import type { AgentState } from '@shared/agentState';
import type { SoundPackEvent } from '@shared/mods';
import { playSoundEvent } from './chime';
import { activeSoundPack, resolveEventSound, useSoundPacks } from './soundPacks';

/**
 * Sound for the moments of a run, detected from the roster's state transitions (never from a render):
 * an agent that was known and is now done, failed or waiting on an approval. The first roster seen is
 * the baseline, and an agent that first appears already in some state is not a transition either.
 * `finale` is not detected here: useFinale owns when a run is finished (OrchestratorStage).
 */

type DetectedEvent = Exclude<SoundPackEvent, 'finale'>;

// Ascending importance. When one tick holds several transitions the most important plays last, and
// playSoundEvent cuts each sound for the next, so that is the one heard.
const EVENT_ORDER: readonly DetectedEvent[] = ['agent-done', 'agent-error', 'approval-requested'];

const EVENT_FOR_STATE: Partial<Record<AgentState, DetectedEvent>> = {
  done: 'agent-done',
  failed: 'agent-error',
  'needs-you': 'approval-requested',
};

/** The events for agents whose state changed between two rosters, each kind once, least important first. */
export function soundEventsBetween(
  previous: ReadonlyMap<string, AgentState>,
  next: ReadonlyMap<string, AgentState>
): DetectedEvent[] {
  const fired = new Set<DetectedEvent>();
  for (const [id, state] of next) {
    const before = previous.get(id);
    if (before === undefined || before === state) continue;
    const event = EVENT_FOR_STATE[state];
    if (event) fired.add(event);
  }
  return EVENT_ORDER.filter(event => fired.has(event));
}

/** The parent session waiting on an approval is one more member of the roster, under a key no session id can take. */
const PARENT_KEY = 'parent';

export function useAgentSoundEvents(
  agents: readonly { id: string; state: AgentState }[],
  parentNeedsYou: boolean
): void {
  const previous = useRef<ReadonlyMap<string, AgentState> | null>(null);
  // Subscribing starts the pack store at stage mount, as the skin store does, not when the view menu first opens.
  useSoundPacks();

  const signature = [...agents.map(agent => `${agent.id}:${agent.state}`), `${PARENT_KEY}:${parentNeedsYou}`].join('|');
  useEffect(() => {
    const next = new Map<string, AgentState>(agents.map(agent => [agent.id, agent.state]));
    next.set(PARENT_KEY, parentNeedsYou ? 'needs-you' : 'working');
    const before = previous.current;
    previous.current = next;
    if (!before) return;
    for (const event of soundEventsBetween(before, next)) {
      playSoundEvent(event, resolveEventSound(event, { packSounds: activeSoundPack()?.sounds }));
    }
    // Keyed on the signature: a re-render that changes no state must not play anything.
  }, [signature]);
}
