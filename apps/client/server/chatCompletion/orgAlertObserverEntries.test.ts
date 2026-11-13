import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
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

  // Websocket lambdas register through the shared wrapper (pinned in
  // packages/server-utils/src/organizations/registerOrgAlertObserver.entries.test.ts).
  it('every websocket lambda loads the registering wrapper or registers directly', () => {
    const dir = path.join(__dirname, '..', 'websocket');
    // Fallback route: replies to unknown actions and touches no credit or roster path.
    const NO_ORG_PATHS = ['default.ts'];
    const uncovered = readdirSync(dir)
      .filter(name => !NO_ORG_PATHS.includes(name) && name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(name))
      .filter(name => {
        const source = readFileSync(path.join(dir, name), 'utf8');
        if (!/^export (const|async function|function) (handler|func)\b/m.test(source)) return false;
        return (
          !source.includes("from '@bike4mind/server-utils/websocket/utils'") &&
          !/^registerOrgAlertObserver\(\);$/m.test(source)
        );
      });
    expect(uncovered).toEqual([]);
  });
});
