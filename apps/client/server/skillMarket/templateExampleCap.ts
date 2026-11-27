import { cacheRepository } from '@bike4mind/database';
import { SKILL_TEMPLATE_EXAMPLE_DAILY_RUN_CAP } from '@bike4mind/common';

/**
 * The author's daily example-run allowance (templateExample.ts). Its own module so the editor view
 * (templateImage.ts) reads it without importing the run code.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** One counter per author per UTC day, across all their templates. */
export const exampleRunCapKey = (userId: string, now: number = Date.now()) =>
  `skill-template-example:author:${userId}:${utcDay(now)}`;

export async function exampleRunsLeftToday(userId: string, now: number = Date.now()): Promise<number> {
  const doc = await cacheRepository.findByKey(exampleRunCapKey(userId, now));
  const used = (doc?.result as { count?: unknown } | undefined)?.count;
  return Math.max(0, SKILL_TEMPLATE_EXAMPLE_DAILY_RUN_CAP - (typeof used === 'number' ? used : 0));
}

export type ExampleRunCap = { key: string; expiresAt: string };

export async function reserveExampleRun(userId: string, now: number = Date.now()): Promise<ExampleRunCap | null> {
  const key = exampleRunCapKey(userId, now);
  const result = await cacheRepository.tryIncrementWithinLimitFixedWindow(
    key,
    SKILL_TEMPLATE_EXAMPLE_DAILY_RUN_CAP,
    DAY_MS - (now % DAY_MS)
  );
  return result.success ? { key, expiresAt: result.expiresAt.toISOString() } : null;
}

/** Gives back a run that failed before producing anything. */
export async function releaseExampleRun(cap: ExampleRunCap): Promise<void> {
  await cacheRepository.releaseFromFixedWindow(cap.key, 1, new Date(cap.expiresAt));
}
