/**
 * @vitest-environment node
 *
 * Pins the alarm relay's access to the LLM spend log groups: the young-account spend alarms
 * list the accounts behind a breach by querying them (apps/workers/src/events/youngAccountSpendDetail.ts),
 * and the relay needs the group name, the query permissions, and time to wait for the answer.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const DLQ_ALARMS = read('infra/dlqAlarms.ts');
const RELAY = DLQ_ALARMS.slice(
  DLQ_ALARMS.indexOf("handler: 'apps/workers/src/events/dlqAlarmToSlack.handler'"),
  DLQ_ALARMS.indexOf('redrivePolicy: dlqAlarmHandlerDlq')
);

describe('alarm relay log query wiring', () => {
  it('hands the relay every log group the spend metrics are filtered from', () => {
    const sourcesImport = "import { llmSpendLogSources } from './llmSpendLogGroups';";
    expect(DLQ_ALARMS).toContain(sourcesImport);
    expect(read('infra/llmSpend.ts')).toContain('llmSpendLogSources()');
    expect(DLQ_ALARMS).toContain('const spendLogGroupNames = llmSpendLogSources().map(source => source.logGroupName);');
    expect(RELAY).toContain("LLM_SPEND_LOG_GROUPS: $util.all(spendLogGroupNames).apply(names => names.join(','))");
    expect(read('apps/workers/src/events/youngAccountSpendDetail.ts')).toContain(
      "export const LLM_SPEND_LOG_GROUPS_ENV = 'LLM_SPEND_LOG_GROUPS';"
    );
  });

  it('lets the relay start a query on those groups only, and read or stop any query', () => {
    expect(RELAY).toContain("actions: ['logs:StartQuery'], resources: spendLogGroupArns");
    expect(RELAY).toContain("actions: ['logs:GetQueryResults', 'logs:StopQuery'], resources: ['*']");
    expect(DLQ_ALARMS).toContain('const arn = aws.cloudwatch.getLogGroupOutput({ name }).arn;');
    expect(DLQ_ALARMS).toContain('return [arn, $interpolate`${arn}:*`];');
  });

  it('gives the relay time to wait for the query', () => {
    expect(RELAY).toContain("timeout: '60 seconds'");
  });
});
