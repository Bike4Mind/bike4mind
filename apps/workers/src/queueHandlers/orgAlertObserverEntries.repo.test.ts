import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

// Org alerts fire only in a process that registered the observer; these entries debit org credits
// or add org members and do not load a module that registers it. Client entries: see
// apps/client/server/chatCompletion/orgAlertObserverEntries.test.ts.
const ENTRIES = [
  'queueHandlers/agentExecutor.ts',
  'queueHandlers/slackQuestProcessor.ts',
  'cron/creditLotSweep.ts',
  'cron/creditHoldSweep.ts',
  'cron/voiceHoldSweep.ts',
  'cron/signupGrantHeldRelease.ts',
  'cron/signupDomainHoldTriage.ts',
  'cron/dataLakeBatchReconcile.ts',
  'selfhost/main.ts',
  'utils/eventContext.ts',
];

const SRC = path.join(__dirname, '..');
const REGISTERS = /^registerOrgAlertObserver\(\);$/m;
// Shared wrappers that register at module load (server-utils ones are pinned by
// packages/server-utils/src/organizations/registerOrgAlertObserver.entries.test.ts).
const COVERED_BY =
  /queueHandlers\/utils'|@workers\/utils\/eventContext'|server-utils\/s3\/utils'|server-utils\/websocket\/utils'/;
const REACHES_ORG_ALERT_EMITTER =
  /creditService|recordOperationalUsage|settleVoiceHold|uploadModerationMeter|moderationScan'|recordSessionOperationalUsage|sessionOperationalCreditGate|releaseHeldSignupCredits|runSignupDomainHoldAssessments|runModerationRescueSweep|addMember|subtractCredits|deductCredits|settleCreditHold|settleJobHold|cliCompletions|ChatCompletionProcess|sharingService/;
// Infra wires worker Lambdas by export name (`<file>.<export>` in infra/), not only handler/func.
const IS_ENTRY =
  /^export (const|async function|function) (handler|func|dispatch|checkAndScheduleProactiveMessages|updateDatabase|ingest)\b/m;

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith('__') ? [] : listSources(full);
    return /\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) ? [full] : [];
  });
}

describe('org alert observer registration', () => {
  it.each(ENTRIES)('%s registers the observer at module load', entry => {
    const source = readFileSync(path.join(SRC, entry), 'utf8');
    expect(source).toContain(
      "import { registerOrgAlertObserver } from '@bike4mind/server-utils/organizations/registerOrgAlertObserver';"
    );
    expect(source).toMatch(REGISTERS);
  });

  it('every lambda entry that reaches an org credit or membership emitter registers the observer', () => {
    const uncovered = listSources(SRC)
      .filter(file => {
        const source = readFileSync(file, 'utf8');
        const isEntry = IS_ENTRY.test(source) || file.endsWith(path.join('selfhost', 'main.ts'));
        return isEntry && REACHES_ORG_ALERT_EMITTER.test(source) && !REGISTERS.test(source) && !COVERED_BY.test(source);
      })
      .map(file => path.relative(SRC, file));
    expect(uncovered).toEqual([]);
  });
});
