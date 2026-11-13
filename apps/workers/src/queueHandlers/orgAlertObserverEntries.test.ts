import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// Org alerts fire only in a process that registered the observer; these entries debit org credits
// and do not load queueHandlers/utils, which registers it for the rest. Client entries: see
// apps/client/server/chatCompletion/orgAlertObserverEntries.test.ts.
const ENTRIES = ['queueHandlers/agentExecutor.ts', 'queueHandlers/slackQuestProcessor.ts', 'cron/creditLotSweep.ts'];

describe('org alert observer registration', () => {
  it.each(ENTRIES)('%s registers the observer at module load', entry => {
    const source = readFileSync(path.join(__dirname, '..', entry), 'utf8');
    expect(source).toContain(
      "import { registerOrgAlertObserver } from '@bike4mind/server-utils/organizations/registerOrgAlertObserver';"
    );
    expect(source).toMatch(/^registerOrgAlertObserver\(\);$/m);
  });
});
