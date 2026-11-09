export const LOOP_MIN_MS = 30_000;
export const LOOP_MAX_MS = 86_400_000;

export const LOOP_HELP =
  '/loop [interval] <prompt or /skill> - repeat in this session while the app is open. ' +
  'Intervals: whole numbers with s, m, h or d, from 30s to 1d (e.g. /loop 5m /review). ' +
  'Omit the interval for model-selected pacing: each reply must end with LOOP_NEXT: <interval>. ' +
  'Missing or invalid decisions pause the loop. /loop list shows status; /loop stop cancels future runs. ' +
  'Runs wait for an idle session; delays start after completion, with no catch-up. ' +
  'Errors pause the loop. Start it again explicitly to resume. Loops never survive app restart or account changes.';

export interface LoopState {
  sessionId: string;
  prompt: string;
  intervalMs: number | null;
  phase: 'scheduled' | 'waiting' | 'running' | 'paused';
  nextRunAt: number | null;
  error?: string;
}

export type LoopResult = { ok: true; state: LoopState | null; notice?: string } | { ok: false; error: string };
export type LoopAction =
  { kind: 'start'; prompt: string; intervalMs: number | null } | { kind: 'stop' } | { kind: 'list' } | { kind: 'help' };

export function loopDuration(text: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(text);
  if (!match) return null;
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: LOOP_MAX_MS }[match[2]];
  const value = Number(match[1]) * (multiplier ?? 0);
  return Number.isSafeInteger(value) && value >= LOOP_MIN_MS && value <= LOOP_MAX_MS ? value : null;
}

export function parseLoop(args: string): LoopAction | { error: string } {
  const text = args.trim();
  if (text === 'stop' || text === 'list' || text === 'help') return { kind: text };
  if (!text) return { error: `A loop needs a prompt. ${LOOP_HELP}` };
  const [first] = text.split(/\s+/);
  let prompt = text;
  let intervalMs: number | null = null;
  if (/^[\d.+-]|^(?:NaN|Infinity)$/i.test(first)) {
    intervalMs = loopDuration(first);
    if (intervalMs === null) return { error: 'Invalid interval. Use whole s, m, h or d, from 30s to 1d.' };
    prompt = text.slice(first.length).trim();
  }
  if (!prompt) return { error: 'A loop needs a prompt or /skill after the interval.' };
  if (/(?:^|\s)\/loop\b/i.test(prompt)) return { error: 'A loop cannot invoke another /loop.' };
  return { kind: 'start', prompt, intervalMs };
}

export function loopDecision(reply: string): number | null {
  const match = /(?:^|\n)LOOP_NEXT: (\S+)\s*$/.exec(reply);
  return match ? loopDuration(match[1]) : null;
}
