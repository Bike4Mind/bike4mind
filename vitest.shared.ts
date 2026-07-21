/**
 * Shared vitest worker-pool budget, consumed by every package's vitest config.
 *
 * By default each package's vitest sizes its worker pool to the full host core
 * count. When an orchestrator (`pnpm -r`, `turbo`) runs several packages at
 * once, that means `concurrent_packages × cores` workers competing for `cores`
 * CPUs — an N× oversubscription that starves CPU-bound suites (notably the
 * `@bike4mind/optihashi-engine` solver benchmarks) past their timeouts. Whether it bites
 * is otherwise down to scheduling luck.
 *
 * `VITEST_MAX_WORKERS` lets the orchestrator hand each package a bounded slice
 * of the machine so the totals stay deterministic — e.g. 4 concurrent packages
 * at `'25%'` each consume the whole box and no more. It accepts an absolute
 * worker count (`'2'`) or a percentage of cores (`'25%'`). Left unset — single
 * package runs and local full-box runs — it preserves vitest's default of using
 * all cores.
 *
 * Spread `sharedTest` into each package's `test` config so the knob applies
 * uniformly. `minWorkers: 1` guarantees at least one worker when a cap is set.
 */
const raw = process.env.VITEST_MAX_WORKERS?.trim();

// vitest accepts `maxWorkers`/`minWorkers` as an absolute count or a "<n>%"
// string; keep a valid percentage verbatim and coerce a positive bare number.
function parseMaxWorkers(value: string | undefined): number | string | undefined {
  if (!value) return undefined;
  if (/^\d+%$/.test(value)) return value;
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : undefined;
}

const maxWorkers = parseMaxWorkers(raw);

// A set-but-malformed value (e.g. "25 %", "25.5%", "-1") would silently revert
// to vitest's all-cores default — reintroducing the exact oversubscription this
// budget exists to prevent. Surface it loudly so CI misconfiguration is caught
// instead of quietly degrading.
if (raw && maxWorkers === undefined) {
  console.warn(
    `[vitest.shared] Ignoring malformed VITEST_MAX_WORKERS="${raw}" — expected a positive integer ("2") or a percentage ("25%"). Falling back to all cores.`
  );
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
