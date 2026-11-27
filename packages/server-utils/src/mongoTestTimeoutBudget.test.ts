import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { auditMongoTestBudget } from '../../database/src/__test__/auditMongoTestBudget';

/**
 * The server-utils counterpart of apps/client/__tests__/mongoTestTimeoutBudget.test.ts - see that
 * file for why every real-Mongo suite must declare the shared budget. Here the lane split lives in
 * ../vitest.config.mts: only `*.e2e.test.ts` runs under `test:integration`, so a real-Mongo suite
 * named otherwise runs inline with the unit suites and flakes on mongod contention.
 */

const SERVER_UTILS_ROOT = path.resolve(__dirname, '..');

const audit = auditMongoTestBudget({ root: SERVER_UTILS_ROOT, skipTopLevel: ['dist', '.turbo'] });

describe('real-Mongo suites in packages/server-utils declare the shared 60s budget', () => {
  it('finds the real-Mongo suites to audit (guards the detector itself)', () => {
    expect(audit.suites).toEqual(
      expect.arrayContaining([
        'src/analytics/signupBaselineReport.e2e.test.ts',
        'src/dataLakes/assertLakeConnectorFree.e2e.test.ts',
        'src/voice/settleVoiceHold.e2e.test.ts',
      ])
    );
  });

  it('names every real-Mongo suite *.e2e.test.ts so it runs in the integration lane', () => {
    expect(audit.suites.filter(relativePath => !relativePath.endsWith('.e2e.test.ts'))).toEqual([]);
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
