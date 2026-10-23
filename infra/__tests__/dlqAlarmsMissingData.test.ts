/**
 * @vitest-environment node
 *
 * Pins the out-of-band DLQ alarms to `treatMissingData: 'missing'`. These are eval=1, so with
 * 'notBreaching' any skipped SQS datapoint resolved them to OK and the next one re-paged.
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
const WAF = read('infra/waf.ts');

/** One alarm's SST id, its source file, and the metric it watches. */
const ALARMS = [
  { id: 'DlqAlarmHandlerDlqMessages', source: DLQ_ALARMS, metric: 'ApproximateNumberOfMessagesVisible' },
  { id: 'DlqAlarmHandlerDlqAge', source: DLQ_ALARMS, metric: 'ApproximateAgeOfOldestMessage' },
  { id: 'WafAlarmSlackHandlerDlqMessages', source: WAF, metric: 'ApproximateNumberOfMessagesVisible' },
  { id: 'WafAlarmSlackHandlerDlqAge', source: WAF, metric: 'ApproximateAgeOfOldestMessage' },
] as const;

// Cuts at the statement's column-2 terminator: `\n  });` for a one-line call head,
// `\n  );` for the multi-line head with a trailing provider option.
function alarmBlock(source: string, id: string): string | undefined {
  return source.match(new RegExp(`new aws\\.cloudwatch\\.MetricAlarm\\(\\s*'${id}',[\\s\\S]*?\\n {2}(?:\\}|)\\);`))?.[0];
}

describe('out-of-band DLQ alarms', () => {
  for (const { id, source, metric } of ALARMS) {
    describe(id, () => {
      const alarm = alarmBlock(source, id);

      it('is found', () => {
        expect(alarm).toBeDefined();
      });

      it('treats a missing datapoint as no information', () => {
        expect(alarm).toMatch(/treatMissingData: 'missing'/);
        expect(alarm).not.toMatch(/treatMissingData: 'notBreaching'/);
      });

      it('still watches the DLQ message metric', () => {
        expect(alarm).toMatch(new RegExp(`metricName: '${metric}'`));
        expect(alarm).toMatch(/namespace: 'AWS\/SQS'/);
      });
    });
  }

  it('keeps the drain path: the fleet alarms still publish OK to the shared topic', () => {
    const createDlqAlarms = DLQ_ALARMS.match(/function createDlqAlarms\([\s\S]*?\n\}/)?.[0];
    expect(createDlqAlarms).toBeDefined();
    expect(createDlqAlarms).toMatch(/okActions: \[dlqAlarmTopic!\.arn\]/);
    expect(createDlqAlarms).toMatch(/alarmActions: \[dlqAlarmTopic!\.arn\]/);
  });
});
