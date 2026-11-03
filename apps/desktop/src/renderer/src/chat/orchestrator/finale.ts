import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage } from '@shared/chat';
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

/** The parent's closing reply: the message "Read the report" lands on. `createdAt` is when its turn settled. */
export interface ParentReport {
  id: string;
  createdAt: string;
}

/**
 * The parent's summary, when its transcript ends on one: an assistant reply with text that neither
 * failed nor was stopped. Anything after it (an agent's "has finished" notice, a new prompt) means
 * the parent has not answered since, so there is no report yet.
 */
export function latestParentReport(messages: readonly ChatMessage[]): ParentReport | undefined {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant' || last.system) return undefined;
  if (last.error || last.stopReason === 'aborted' || last.content.trim() === '') return undefined;
  return { id: last.id, createdAt: last.createdAt };
}

/** Whether the report was written after every agent last changed, so it speaks for their final work. */
export function reportFollowsAgents(report: ParentReport, agents: readonly AgentView[]): boolean {
  const written = Date.parse(report.createdAt);
  if (Number.isNaN(written)) return false;
  return agents.every(agent => !(Date.parse(agent.updatedAt) > written));
}

/**
 * Whether the "Quest complete" finale is showing: when every agent has settled, the parent has stopped,
 * and the parent's last turn ended on a summary written after the agents finished; and only after an
 * agent was seen working while mounted, so reopening a finished run never replays it. Showing it spends
 * that sighting, so archiving or deleting an agent afterwards never brings it back. The remembered run
 * pairs the agent set with the summary's id, so re-running the same agents to a new summary celebrates
 * again while a reload of the same completion does not. `rootId` scopes the remembered run.
 */
export function useFinale(
  rootId: string | undefined,
  agents: readonly AgentView[],
  parent: ParentView,
  report: ParentReport | undefined
): { shown: boolean; dismiss(): void } {
  const active = agents.some(isActive);
  const parentBusy = isParentBusy(parent);
  const [sawWork, setSawWork] = useState(active);
  if (active && !sawWork) setSawWork(true);
  const [shown, setShown] = useState(false);
  if (shown && (active || parentBusy)) setShown(false);

  const complete =
    sawWork &&
    agents.length > 0 &&
    !active &&
    !parentBusy &&
    report !== undefined &&
    reportFollowsAgents(report, agents);
  const run = complete ? `${runKey(agents)}@${report.id}` : null;

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
