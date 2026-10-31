/**
 * @vitest-environment node
 *
 * Pins the alarm relay's access to the ChatCompletion log group: the young-account spend alarms
 * list the accounts behind a breach by querying it (apps/workers/src/events/youngAccountSpendDetail.ts),
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
  it('hands the relay the ChatCompletion log group name the spend metrics are filtered from', () => {
    expect(DLQ_ALARMS).toContain("import { chatCompletionLogGroupName } from './chatCompletionLogGroup';");
    expect(read('infra/llmSpend.ts')).toContain(
      "import { chatCompletionLogGroupName } from './chatCompletionLogGroup';"
    );
    expect(RELAY).toContain('LLM_SPEND_LOG_GROUP: chatCompletionLogGroupName');
  });

  it('lets the relay start a query on that group only, and read or stop any query', () => {
    expect(RELAY).toMatch(/actions: \['logs:StartQuery'\], resources: \[spendLogGroupArn, /);
    expect(RELAY).toContain("actions: ['logs:GetQueryResults', 'logs:StopQuery'], resources: ['*']");
    expect(DLQ_ALARMS).toContain(':log-group:${chatCompletionLogGroupName}`');
  });

  it('gives the relay time to wait for the query', () => {
    expect(RELAY).toContain("timeout: '60 seconds'");
  });
});
