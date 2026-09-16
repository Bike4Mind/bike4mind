import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { auditMongoTestBudget } from '../../database/src/__test__/auditMongoTestBudget';

/**
 * Structural guard for this shard's real-Mongo suites - the same invariant apps/client audits, so
 * the detector itself lives in one place next to MONGO_TEST_TIMEOUT_MS.
 *
 * This package's real-Mongo migration suites are the ones the CI "misc" leg times out on: the
 * shard budget is 30s for tests and 30s for hooks, both sized for unit tests, and a mongod cold
 * start crosses that at random under the leg's file parallelism. Declaring the shared 60s budget
 * per file is the fix; this keeps the next migration suite from landing without it.
 */

const SCRIPTS_ROOT = path.resolve(__dirname, '..');

const audit = auditMongoTestBudget({ root: SCRIPTS_ROOT, skipTopLevel: ['dist', '.turbo'] });

describe('real-Mongo suites in the scripts shard declare the shared 60s budget', () => {
  it('finds the real-Mongo suites to audit (guards the detector itself)', () => {
    // A broken detector would make every assertion below vacuously pass, so pin the class as
    // non-empty and pin the suite the CI timeout was traced to.
    expect(audit.suites.length).toBeGreaterThan(10);
    expect(audit.suites).toContain('migrate/migrations/20260810000000_drop-legacy-fabfilechunk-indexes.test.ts');
  });

  it('imports MONGO_TEST_TIMEOUT_MS rather than inventing a budget', () => {
    expect(audit.missingBudgetImport).toEqual([]);
  });

  it('applies the budget to tests AND hooks via the effective vi.setConfig', () => {
    expect(audit.missingSharedBudget).toEqual([]);
  });

  it('never pins a test, suite or hook back with a literal timeout', () => {
    expect(audit.literalTimeouts).toEqual([]);
  });
});
