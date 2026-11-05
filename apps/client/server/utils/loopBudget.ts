import { nextIterationCredits, startOfUtcDay, type ILoop } from '@bike4mind/common';
import {
  adminSettingsRepository,
  agentExecutionRepository,
  apiKeyRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { getAvailableModels, resolveDeprecatedModelId, type ApiKeyTable } from '@bike4mind/llm-adapters';
import { apiKeyService, creditService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';

/** Floor on an iteration's price in budget checks, so an unpriceable model still needs some allowance left. */
export const MIN_ITERATION_CREDITS = 0.01;

/**
 * Loop runs in flight at once across all users. Loop and interactive runs share the AgentExecutor's
 * `reserved` concurrency (infra/agentExecutor.ts); keep this well below it so interactive runs keep most slots.
 * Read by the scheduler (apps/workers/src/cron/loopScheduler.ts) and the Run now route's pre-check.
 */
export const MAX_ACTIVE_LOOP_RUNS = 4;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The daily cap on what all of a user's loops spend together: the lower of the admin
 * `LoopsDailyCreditsPerUser` (0 = none) and the user's own `loopsDailyCredits`. `effective` is undefined
 * when neither is set. Shared by the loop scheduler and the loops budget route.
 */
export async function userLoopsDailyCap(
  userId: string
): Promise<{ admin?: number; user?: number; effective?: number }> {
  const [adminValue, user] = await Promise.all([
    adminSettingsRepository.getSettingsValue('LoopsDailyCreditsPerUser'),
    userRepository.findById(userId),
  ]);
  const admin = positive(adminValue);
  const own = positive(user?.loopsDailyCredits);
  const set = [admin, own].filter((cap): cap is number => cap !== undefined);
  return { admin, user: own, effective: set.length > 0 ? Math.min(...set) : undefined };
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

/**
 * Whether the account the executor bills can pay for the loop's first iteration, by the executor's own
 * admission rule (agentExecutor.ts pre-flight credit check): a positive balance that covers
 * `nextIterationCredits` when `enforceCredits` is on, and for an org, the member under its cap.
 */
export async function canPayAgain(
  loop: ILoop,
  price: () => Promise<number> = () => iterationPrice(loop)
): Promise<boolean> {
  const org = loop.organizationId ? await organizationRepository.findById(loop.organizationId) : null;
  const payer = loop.organizationId ? org : await userRepository.findById(loop.userId);
  const balance = payer?.currentCredits ?? 0;
  if (balance <= 0 || (org && creditService.isMemberAtOrOverCap(org, loop.userId))) return false;
  if ((await adminSettingsRepository.getSettingsValue('enforceCredits')) !== true) return true;
  return balance >= (await price());
}

/** What the loop's first iteration costs on `model`, whether or not credits are enforced; 0 when unpriceable. */
export async function iterationPrice(loop: ILoop, model = loop.model): Promise<number> {
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(loop.userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });
  const models = await getAvailableModels(apiKeyTable as ApiKeyTable);
  const modelId = resolveDeprecatedModelId(model, 'loopBudget');
  const modelInfo = models.find((m: { id: string }) => m.id === modelId);
  return modelInfo ? nextIterationCredits(modelInfo, 0) : 0;
}

/** Why a loop run was not admitted; `paced` carries when its paced allowances next cover one iteration. */
export type LoopAdmission =
  | { ok: true; creditCap?: number }
  | { ok: false; kind: 'credits' | 'loop_budget' | 'user_budget' }
  | { ok: false; kind: 'paced'; readyAt: Date };

/**
 * Admission before a loop run on `model`, in order: the payer can cover one iteration, the loop's daily budget
 * and the owner's all-loops budget each have one iteration left, and their paced allowances cover one. Side-effect
 * free: the scheduler's `admit` (apps/workers/src/cron/loopScheduler.ts) pauses or defers on a refusal, the desktop
 * runner claim (loopRunner.ts) only refuses. On admission, `creditCap` is the run's cap (undefined: none).
 */
export async function loopAdmission(loop: ILoop, model: string, now: Date): Promise<LoopAdmission> {
  let pricing: Promise<number> | undefined;
  const price = () => (pricing ??= iterationPrice(loop, model));
  const budgetPrice = async () => Math.max(await price(), MIN_ITERATION_CREDITS);
  const today = startOfUtcDay(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);

  if (!(await canPayAgain(loop, price))) return { ok: false, kind: 'credits' };

  const budgets: Array<{ budget: number; spent: number }> = [];
  if (loop.budgetCreditsPerDay) {
    const spent =
      (await agentExecutionRepository.sumCreditsByLoop([loop.id], [loop.sessionId], today, true))[loop.id] ?? 0;
    if (loop.budgetCreditsPerDay - spent < (await budgetPrice())) return { ok: false, kind: 'loop_budget' };
    budgets.push({ budget: loop.budgetCreditsPerDay, spent });
  }

  const userCap = (await userLoopsDailyCap(loop.userId)).effective;
  if (userCap) {
    const spent = await agentExecutionRepository.sumLoopCreditsForUser(loop.userId, today, true);
    if (userCap - spent < (await budgetPrice())) return { ok: false, kind: 'user_budget' };
    budgets.push({ budget: userCap, spent });
  }

  const iteration = budgets.length > 0 ? await budgetPrice() : 0;
  const paced = budgets.map(({ budget, spent }) => ({
    remaining: pacedAllowance(budget, now) - spent,
    readyAt: pacedReadyAt(budget, spent, iteration, now) ?? tomorrow,
  }));
  const short = paced.filter(({ remaining }) => remaining < iteration);
  if (short.length > 0) {
    const readyAt = new Date(
      Math.max(now.getTime() + loop.intervalMinutes * MINUTE_MS, ...short.map(({ readyAt }) => readyAt.getTime()))
    );
    return { ok: false, kind: 'paced', readyAt };
  }

  return {
    ok: true,
    creditCap: runCreditCap([
      ...budgets.map(({ budget, spent }) => budget - spent),
      ...paced.map(({ remaining }) => remaining),
    ]),
  };
}
