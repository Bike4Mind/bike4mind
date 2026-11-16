import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// Shared lambda wrappers that register the org alert observer for every handler built on them.
// Entry-side guards: apps/workers/src/queueHandlers/orgAlertObserverEntries.test.ts and
// apps/client/server/chatCompletion/orgAlertObserverEntries.test.ts.
const WRAPPERS = ['queueHandlers/utils.ts', 'websocket/utils.ts', 's3/utils.ts'];

describe('org alert observer registration in shared wrappers', () => {
  it.each(WRAPPERS)('%s registers the observer at module load', wrapper => {
    const source = readFileSync(path.join(__dirname, '..', wrapper), 'utf8');
    expect(source).toContain("import { registerOrgAlertObserver } from '../organizations/registerOrgAlertObserver';");
    expect(source).toMatch(/^registerOrgAlertObserver\(\);$/m);
  });
});
