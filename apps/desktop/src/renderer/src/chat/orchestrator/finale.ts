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

/** The parent's final summary: the message "Read the report" lands on. */
export interface ParentReport {
  id: string;
  createdAt: string;
  /** The quest_complete reply before this one: agents created by then belong to an earlier quest. */
  since?: string;
}

/**
 * The newest reply the parent marked with quest_complete, if any. The mark is the only signal: an
 * interim reply ("waiting on the install") looks just like a final one from the transcript's shape.
 */
export function latestQuestReport(messages: readonly ChatMessage[]): ParentReport | undefined {
  const reports = messages.filter(message => message.role === 'assistant' && message.questComplete === true);
  const latest = reports.at(-1);
  if (!latest) return undefined;
  const previous = reports.at(-2);
  return previous
    ? { id: latest.id, createdAt: latest.createdAt, since: previous.createdAt }
    : { id: latest.id, createdAt: latest.createdAt };
}

/** The agents of the quest `report` closes, so a second quest's finale counts only its own run. */
export function questAgents(agents: readonly AgentView[], report: ParentReport | undefined): readonly AgentView[] {
  const since = report?.since;
  if (since === undefined) return agents;
  return agents.filter(agent => agent.createdAt > since);
}

/** Whether every agent ended done, which is what earns "Quest complete" over "Quest ended". */
export function questSucceeded(stats: FinaleStats): boolean {
  return stats.failed === 0 && stats.done === stats.agents;
}

/**
 * Whether the finale is showing: the parent has marked a summary with quest_complete, nothing is
 * running, and that summary has not been shown before. Showing it records the summary's id per
 * `rootId`, so a reload never replays it while a later quest_complete gets a finale of its own.
 */
export function useFinale(
  rootId: string | undefined,
  agents: readonly AgentView[],
  parent: ParentView,
  report: ParentReport | undefined
): { shown: boolean; dismiss(): void } {
  const active = agents.some(isActive);
  const parentBusy = isParentBusy(parent);
  const [shown, setShown] = useState(false);
  if (shown && (active || parentBusy)) setShown(false);

  const pending = report !== undefined && agents.length > 0 && !active && !parentBusy ? report.id : null;

  useEffect(() => {
    if (pending === null || rootId === undefined || readFinaleSeen(rootId) === pending) return;
    const timer = window.setTimeout(() => {
      writeFinaleSeen(rootId, pending);
      setShown(true);
    }, FINALE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [rootId, pending]);

  const dismiss = useCallback(() => setShown(false), []);
  return { shown, dismiss };
}
