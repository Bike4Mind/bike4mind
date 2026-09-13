import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { auditMongoTestBudget } from '../../../packages/database/src/__test__/auditMongoTestBudget';

/**
 * Structural guard for the client shard's real-Mongo suites - the same invariant packages/scripts
 * audits, so the detector itself lives in one place next to MONGO_TEST_TIMEOUT_MS.
 *
 * A suite that boots a real mongod pays a cold start whose cost scales with runner contention -
 * 3-12s per file on a healthy CI run, past 35s on a busy machine (see MONGO_TEST_TIMEOUT_MS in
 * packages/database/src/__test__/createMongoServer.ts). This shard sets a 30s test budget and
 * inherits a 30s hook budget, both sized for unit tests, so they sit inside that spread and get
 * crossed at random - a timeout with no failed assertion, green on re-run of the same commit.
 *
 * Auditing that by hand only holds until the next suite is added, so the audit lives here: every
 * real-Mongo suite in this shard must declare the shared budget for its tests AND its hooks, and
 * none may pin itself back with a literal.
 */

const CLIENT_ROOT = path.resolve(__dirname, '..');

// Anchored to top-level segments: a nested directory that happens to be called `e2e` holds real
// unit suites and must still be audited (vitest's own `exclude` is a separate glob - keeping this
// list narrow is what stops the two from silently disagreeing).
const SKIP_TOP_LEVEL = ['.next', '.open-next', 'e2e', 'dist', '.turbo'];

const audit = auditMongoTestBudget({ root: CLIENT_ROOT, skipTopLevel: SKIP_TOP_LEVEL });

describe('real-Mongo suites in the client shard declare the shared 60s budget', () => {
  it('finds the real-Mongo suites to audit (guards the detector itself)', () => {
    // A broken detector would make every assertion below vacuously pass, so pin the class as
    // non-empty and pin the suite the budget was first raised for.
    expect(audit.suites.length).toBeGreaterThan(10);
    expect(audit.suites).toContain('server/services/deleteOrganizationTransaction.e2e.test.ts');
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
