import { startOfUtcDay } from '../types/entities/LoopTypes';
import type { WorkItemPriority } from '../types/entities/WorkItemTypes';

/** Floor on an iteration's price in budget checks, so an unpriceable model still needs some allowance left. */
export const MIN_ITERATION_CREDITS = 0.01;

const MINUTE_MS = 60 * 1000;

const HOUR_MS = 60 * MINUTE_MS;

/**
 * One lane's credit cap: an even share of the admitted cap across the lanes the loop can still open (this one
 * included), so lanes started together never reserve more than the budget left. The split is over at most as many
 * lanes as the cap covers iterations (`minPrice`), so a cap one lane could use is never split into shares none can.
 * `too_small` when the whole cap is under one iteration; undefined (no cap) when the admission had none.
 */
export function laneCreditCap(
  admissionCap: number | undefined,
  lanesLeft: number,
  minPrice: number
): number | undefined | 'too_small' {
  if (admissionCap === undefined) return undefined;
  const share = admissionCap / Math.max(1, Math.min(lanesLeft, Math.floor(admissionCap / minPrice)));
  return share < minPrice ? 'too_small' : share;
}

/** What a daily budget allows spent by `now`: 1/24 in the first UTC hour, all of it in the last. Unspent allowance carries forward. */
export function pacedAllowance(budget: number, now: Date): number {
  const hours = (now.getTime() - startOfUtcDay(now).getTime()) / HOUR_MS;
  return budget * Math.min(1, (hours + 1) / 24);
}

/** When the paced allowance first covers `spent + price`, rounded up to the minute; null when the whole budget does not. */
export function pacedReadyAt(budget: number, spent: number, price: number, now: Date): Date | null {
  const need = spent + price;
  if (need > budget) return null;
  const at = startOfUtcDay(now).getTime() + Math.max(0, (24 * need) / budget - 1) * HOUR_MS;
  return new Date(Math.ceil(at / MINUTE_MS) * MINUTE_MS);
}

/** The lowest of the limits that are set; undefined (no cap) when none is. */
export function runCreditCap(limits: Array<number | undefined>): number | undefined {
  const set = limits.filter((limit): limit is number => limit !== undefined);
  return set.length > 0 ? Math.max(0, Math.min(...set)) : undefined;
}

/** What a loop works once its p2 runs for the day are used up: p2 and p3 wait until 00:00 UTC. */
export const PRIORITIES_OVER_P2_CAP: WorkItemPriority[] = ['p0', 'p1'];

/**
 * Why a loop run was not admitted; `paced` carries when its paced allowances next cover one iteration, and a
 * `loop_budget` refusal carries `belowOneRun` (the iteration price) when even the unspent budget cannot cover it.
 */
export type LoopAdmission =
  | { ok: true; creditCap?: number; iterationCredits: number }
  | { ok: false; kind: 'credits' | 'user_budget' }
  | { ok: false; kind: 'loop_budget'; belowOneRun?: number }
  | { ok: false; kind: 'paced'; readyAt: Date };

/** Why a loop whose whole daily budget is under one iteration's `price` cannot run; no amount of waiting fixes it. */
export const budgetBelowRunReason = (price: number): string =>
  `Daily budget is below the cost of one run (about ${Math.ceil(price)} credits); raise it to at least that`;
