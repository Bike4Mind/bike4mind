import { useCallback, useSyncExternalStore } from 'react';
import type { ChatTokenRate } from '@shared/chat';
import { formatTokens } from './statusLine';

/**
 * Whether replies from self-hosted models show their generation speed. Per-machine UI state in
 * localStorage, with subscribers, as in worktreeDefault.ts: Settings and every reply read it.
 */
const STORAGE_KEY = 'b4m.chat.showTokenRate';

/** Defaults ON: it shows only on self-hosted replies, and only on hover. */
export function parseStoredTokenRate(raw: string | null): boolean {
  return raw !== '0';
}

let enabled = readStored();
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return parseStoredTokenRate(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return true;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function showTokenRate(): boolean {
  return enabled;
}

export function setShowTokenRate(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a settings click.
  }
  for (const listener of listeners) listener();
}

export function useShowTokenRate(): boolean {
  return useSyncExternalStore(subscribe, showTokenRate, showTokenRate);
}

/** The setting and its toggle, for Settings. */
export function useTokenRateSetting(): [boolean, () => void] {
  const value = useShowTokenRate();
  const toggle = useCallback(() => setShowTokenRate(!showTokenRate()), []);
  return [value, toggle];
}

export function tokenRateSummary(enabled: boolean): string {
  return enabled ? 'Tokens per second under replies from self-hosted models' : 'Off';
}

function perSecond(tokens: number, ms: number): number {
  return (tokens / ms) * 1000;
}

function formatPerSecond(rate: number): string {
  return `${rate >= 100 ? Math.round(rate) : rate.toFixed(1)} tok/s`;
}

export function formatSeconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** "23.9 tok/s", or "~23.9 tok/s" when this app timed the stream itself. Null with nothing measured. */
export function formatTokenRate(rate: ChatTokenRate | null | undefined): string | null {
  if (!rate || rate.evalTokens <= 0 || rate.evalMs <= 0) return null;
  return `${rate.estimated ? '~' : ''}${formatPerSecond(perSecond(rate.evalTokens, rate.evalMs))}`;
}

/**
 * The tooltip lines: generation, then prompt, load and draft acceptance where the server reported
 * them. `outputTokens` is the whole turn's; when it exceeds the timed tokens, the line says so.
 */
export function describeTokenRate(rate: ChatTokenRate | null | undefined, outputTokens?: number): string | null {
  const headline = formatTokenRate(rate);
  if (!rate || !headline) return null;
  const timed =
    outputTokens !== undefined && outputTokens > rate.evalTokens
      ? `timed ${formatTokens(rate.evalTokens)} of ${formatTokens(outputTokens)} output tokens`
      : `${formatTokens(rate.evalTokens)} tokens`;
  const lines = [`Generation: ${headline} (${timed} in ${formatSeconds(rate.evalMs)})`];
  if (rate.estimated) lines.push('Estimated from stream timing; the server reported no timings');
  if (rate.promptTokens !== undefined && rate.promptMs !== undefined && rate.promptMs > 0)
    lines.push(
      `Prompt: ${formatPerSecond(perSecond(rate.promptTokens, rate.promptMs))} (${formatTokens(rate.promptTokens)} tokens in ${formatSeconds(rate.promptMs)})`
    );
  if (rate.loadMs !== undefined) lines.push(`Load (total): ${formatSeconds(rate.loadMs)}`);
  if (rate.draftTokens !== undefined && rate.draftAccepted !== undefined && rate.draftTokens > 0)
    lines.push(
      `Draft acceptance: ${Math.round((rate.draftAccepted / rate.draftTokens) * 100)}% (${rate.draftAccepted} of ${rate.draftTokens})`
    );
  return lines.join('\n');
}
