import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// Org alerts fire only in a process that registered the observer; these entries settle org credits
// or change rosters and load no other module that registers it. Workers entries: see
// apps/workers/src/queueHandlers/orgAlertObserverEntries.test.ts.
const ENTRIES = ['chatCompletion/server.ts', 'middlewares/baseApi.ts'];

describe('org alert observer registration', () => {
  it.each(ENTRIES)('%s registers the observer at module load', entry => {
    const source = readFileSync(path.join(__dirname, '..', entry), 'utf8');
    expect(source).toContain(
      "import { registerOrgAlertObserver } from '@bike4mind/server-utils/organizations/registerOrgAlertObserver';"
    );
    // Zero indent on purpose: a guarded or nested call would not register at module load.
    expect(source, 'registerOrgAlertObserver() must be an unconditional top-level call').toMatch(
      /^registerOrgAlertObserver\(\);$/m
    );
  });
});
