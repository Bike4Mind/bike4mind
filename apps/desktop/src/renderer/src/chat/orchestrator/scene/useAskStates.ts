import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentState } from '@shared/agentState';
import type { PendingDecision } from '@shared/pendingDecisions';
import type { AgentView } from '../roster';
import { sceneAskOf, type AskOutcome, type SceneAsk } from './sceneAsk';

/** How long the bubble shows how a request ended before it clears, in ms. */
export const ASK_OUTCOME_MS = 2500;

export type AskOutcomeShown = { state: AskOutcome; ask: SceneAsk; until: number };

/**
 * The requests the scene's dialogue box holds (one per session, the front one) and, for a short while after
 * each one ends, how it ended. An answer from the box is `approved`, `denied` or `answered`. A request that
 * goes away while its agent has moved on without one is `elsewhere`. One that goes away while the agent is
 * still waiting (a reload) is neither.
 */
export function useAskStates(dialogue: boolean, agents: readonly AgentView[]) {
  const [asks, setAsks] = useState<ReadonlyMap<string, PendingDecision>>(() => new Map());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, AskOutcomeShown>>(() => new Map());
  const reported = useRef<ReadonlyMap<string, PendingDecision>>(new Map());
  const states = useRef(new Map<string, AgentState>());
  states.current = new Map(agents.map(agent => [agent.id, agent.state]));

  useEffect(() => {
    if (dialogue) return;
    reported.current = new Map();
    setAsks(new Map());
  }, [dialogue]);

  const onAsksChange = useCallback((next: ReadonlyMap<string, PendingDecision>) => {
    const before = reported.current;
    reported.current = next;
    setAsks(next);
    const gone = [...before].filter(([id]) => {
      const state = states.current.get(id);
      return !next.has(id) && state !== undefined && state !== 'needs-you';
    });
    if (gone.length === 0) return;
    const until = Date.now() + ASK_OUTCOME_MS;
    setOutcomes(previous => {
      const shown = new Map(previous);
      for (const [id, decision] of gone) {
        if (!shown.has(id)) shown.set(id, { state: 'elsewhere', ask: sceneAskOf(decision), until });
      }
      return shown;
    });
  }, []);

  const onAnswered = useCallback((sessionId: string, outcome: Exclude<AskOutcome, 'elsewhere'>) => {
    const decision = reported.current.get(sessionId);
    if (!decision) return;
    const shown = { state: outcome, ask: sceneAskOf(decision), until: Date.now() + ASK_OUTCOME_MS };
    setOutcomes(previous => new Map(previous).set(sessionId, shown));
  }, []);

  useEffect(() => {
    if (outcomes.size === 0) return;
    const soonest = Math.min(...[...outcomes.values()].map(shown => shown.until));
    const timer = setTimeout(
      () => setOutcomes(previous => new Map([...previous].filter(([, shown]) => shown.until > Date.now()))),
      Math.max(0, soonest - Date.now())
    );
    return () => clearTimeout(timer);
  }, [outcomes]);

  return { asks, outcomes, onAsksChange, onAnswered };
}
