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
  // Only an agent that was waiting when its ask was last seen can have had it answered elsewhere: a failed
  // or stopped agent's Retry card going away is not an answer.
  const waiting = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (dialogue) return;
    reported.current = new Map();
    waiting.current = new Set();
    setAsks(new Map());
  }, [dialogue]);

  const onAsksChange = useCallback((next: ReadonlyMap<string, PendingDecision>) => {
    const before = reported.current;
    const wasWaiting = waiting.current;
    reported.current = next;
    waiting.current = new Set([...next.keys()].filter(id => states.current.get(id) === 'needs-you'));
    setAsks(next);
    const gone = [...before].filter(([id]) => {
      const state = states.current.get(id);
      return wasWaiting.has(id) && !next.has(id) && state !== undefined && state !== 'needs-you';
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

  // Takes the answered request itself: the box may have answered a later one than the session's first, and
  // the status push can drop it from `reported` before the answer's promise settles.
  const onAnswered = useCallback((decision: PendingDecision, outcome: Exclude<AskOutcome, 'elsewhere'>) => {
    const shown = { state: outcome, ask: sceneAskOf(decision), until: Date.now() + ASK_OUTCOME_MS };
    setOutcomes(previous => new Map(previous).set(decision.sessionId, shown));
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
