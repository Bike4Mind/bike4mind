import { availableParallelism } from 'node:os';

/**
 * Shared vitest worker-pool budget, consumed by every package's vitest config.
 *
 * By default each package's vitest sizes its worker pool to the full host core
 * count. When an orchestrator (`pnpm -r`, `turbo`) runs several packages at
 * once, that means `concurrent_packages x cores` workers competing for `cores`
 * CPUs, an N-fold oversubscription that starves CPU-bound suites (notably the
 * `@bike4mind/optihashi-engine` solver benchmarks) past their timeouts. Whether it bites
 * is otherwise down to scheduling luck.
 *
 * `VITEST_MAX_WORKERS` lets the orchestrator hand each package a bounded slice
 * of the machine so the totals stay deterministic - e.g. 4 concurrent packages
 * at `'25%'` each consume the whole box and no more. It accepts an absolute
 * worker count (`'2'`) or a percentage of cores (`'25%'`). Left unset - single
 * package runs and local full-box runs - it preserves vitest's default of using
 * all cores.
 *
 * Spread `sharedTest` into each package's `test` config so the knob applies
 * uniformly. `minWorkers: 1` guarantees at least one worker when a cap is set.
 */
const WORKER_BUDGET_ENV = 'VITEST_MAX_WORKERS';

/**
 * Resolves a `VITEST_MAX_WORKERS` value to an absolute worker count, or `undefined` when unset.
 *
 * The count must be absolute because vitest reads this SAME env var itself, after the config is
 * loaded, with a bare `Number.parseInt` that overrides `test.maxWorkers` (vitest 4,
 * `resolveConfig`). Handed `'25%'` it silently runs 25 workers per package, on any core count:
 * that turned CI's 4-package x 25% buckets on a 4-vCPU runner into up to 100 forks, one mongod per
 * real-Mongo file, and its "Hook timed out" flakes. Same formula vitest applies to a percentage
 * it does parse (round, clamped to [1, cores]), so the result matches what the value means.
 *
 * A malformed value throws rather than warns: vitest would still `parseInt` it into something
 * arbitrary ("25 %" -> 25, "-1" -> -1), so there is no safe fallback to degrade to.
 * `vitestWorkerBudget.test.ts` in packages/scripts pins this.
 */
export function resolveMaxWorkers(value: string | undefined, cores: number): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const percentage = /^(\d+)%$/.exec(raw);
  if (percentage) {
    const share = Math.round((Number(percentage[1]) / 100) * cores);
    return Math.max(1, Math.min(cores, share));
  }

  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);

  throw new Error(
    `[vitest.shared] Malformed ${WORKER_BUDGET_ENV}="${raw}" - expected a positive integer ("2") or a percentage ("25%").`
  );
}

const maxWorkers = resolveMaxWorkers(process.env[WORKER_BUDGET_ENV], availableParallelism());

// Write the resolved count back so vitest's own env read (see resolveMaxWorkers) sees the same
// integer this config asks for. Config files load before vitest resolves its config, so this lands
// in time, and forks inherit the normalized value.
if (maxWorkers !== undefined) {
  process.env[WORKER_BUDGET_ENV] = String(maxWorkers);
}

// vitest's defaults (5s per test, 10s per hook) suit pure unit tests but are too tight for
// the I/O-bound suites - real MongoMemoryServer via createMongoServer, solver benchmarks -
// once CI shards the matrix and VITEST_MAX_WORKERS packs several packages onto the same
// cores. Under that contention a trivial DB seed can stall past 5s purely on CPU starvation,
// not because anything is wrong, which surfaces as a spurious timeout failure (a flaky red).
// Raise the floor so contention shows up as slowness rather than failure; a genuinely hung
// test still fails, just after a longer wait. Because every package spreads `sharedTest`
// FIRST, any package needing a different value (e.g. `@bike4mind/database`'s hookTimeout:
// 60000 for the one-time Mongo binary download) overrides it by setting the key afterward.
const TEST_TIMEOUT_MS = 15_000;
const HOOK_TIMEOUT_MS = 30_000;

export const sharedTest = {
  testTimeout: TEST_TIMEOUT_MS,
  hookTimeout: HOOK_TIMEOUT_MS,
  ...(maxWorkers !== undefined ? { maxWorkers, minWorkers: 1 } : {}),
};
