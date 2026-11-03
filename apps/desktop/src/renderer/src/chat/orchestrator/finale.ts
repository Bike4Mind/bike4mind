import { useCallback, useEffect, useState } from 'react';
import { readFinaleSeen, writeFinaleSeen } from './orchestratorPrefs';
import {
  formatAgentCost,
  isParentBusy,
  summarizeRoster,
  type AgentState,
  type AgentView,
  type ParentView,
} from './roster';

/** How long a finished run must stay finished before the finale plays (ms), so a parent that picks straight back up never sees it. */
export const FINALE_SETTLE_MS = 1500;

const ACTIVE: ReadonlySet<AgentState> = new Set(['working', 'needs-you']);
const isActive = (agent: AgentView) => ACTIVE.has(agent.state);

export interface FinaleStats {
  agents: number;
  /** First agent created to last agent updated. */
  wallMs: number;
  cost: string;
  done: number;
  failed: number;
}

export function finaleStats(agents: readonly AgentView[]): FinaleStats {
  const { total, counts, usdCost, credits, hasUsd, hasCost, costPartial } = summarizeRoster(agents);
  const started = Math.min(...agents.map(agent => Date.parse(agent.createdAt)));
  const ended = Math.max(...agents.map(agent => Date.parse(agent.updatedAt)));
  const cost = hasCost ? `${costPartial ? '~' : ''}${formatAgentCost(hasUsd ? usdCost : undefined, credits)}` : '-';
  return {
    agents: total,
    wallMs: agents.length > 0 ? Math.max(0, ended - started) : 0,
    cost,
    done: counts.done,
    failed: counts.failed,
  };
}

const pad = (value: number) => String(value).padStart(2, '0');

export function formatWallTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

/** Names a run by the set of its agents, so the same run is recognised across reopens. */
export function runKey(agents: readonly AgentView[]): string {
  const ids = agents
    .map(agent => agent.id)
    .sort()
    .join('\n');
  let hash = 5381;
  for (let index = 0; index < ids.length; index++) hash = ((hash * 33) ^ ids.charCodeAt(index)) >>> 0;
  return `${agents.length}-${hash.toString(36)}`;
}

/**
 * Whether the "Quest complete" finale is showing: once per run, when every agent has settled and the
 * parent has stopped, and only after an agent was seen working while mounted, so reopening a
 * finished run never replays it. Showing it spends that sighting, so archiving or deleting an agent
 * afterwards (which changes the run key) never brings it back. `rootId` scopes the remembered run.
 */
export function useFinale(
  rootId: string | undefined,
  agents: readonly AgentView[],
  parent: ParentView
): { shown: boolean; dismiss(): void } {
  const active = agents.some(isActive);
  const parentBusy = isParentBusy(parent);
  const [sawWork, setSawWork] = useState(active);
  if (active && !sawWork) setSawWork(true);
  const [shown, setShown] = useState(false);
  if (shown && (active || parentBusy)) setShown(false);

  const complete = sawWork && agents.length > 0 && !active && !parentBusy;
  const run = complete ? runKey(agents) : null;

  useEffect(() => {
    if (run === null || rootId === undefined || readFinaleSeen(rootId) === run) return;
    const timer = window.setTimeout(() => {
      writeFinaleSeen(rootId, run);
      setSawWork(false);
      setShown(true);
    }, FINALE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [rootId, run]);

  const dismiss = useCallback(() => setShown(false), []);
  return { shown, dismiss };
}
