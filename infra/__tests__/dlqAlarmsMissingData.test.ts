/**
 * @vitest-environment node
 *
 * Pins the out-of-band DLQ alarms. `treatMissingData: 'ignore'` holds the alarm state across a
 * skipped SQS datapoint, where 'notBreaching' resolved it to OK and the next datapoint re-paged;
 * the age alarms read the age metric through IF(visible > 0, age, 0) because SQS stops
 * publishing it on an empty queue, which is what lets a drained DLQ still reach OK.
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

/** Drops whole-line `//` comments so a commented-out field cannot satisfy a match. */
const stripComments = (source: string): string => source.replace(/^\s*\/\/.*$/gm, '');

/**
 * The source of one alarm, from `new aws.cloudwatch.MetricAlarm(` to its balanced closing
 * paren. Balanced rather than a formatting-exact terminator, so a block can never silently
 * resolve to its neighbour's text or run on into the surrounding function.
 */
function alarmBlock(source: string, id: string): string {
  const idAt = source.indexOf(`'${id}'`);
  if (idAt < 0) return '';
  const callStart = source.lastIndexOf('new aws.cloudwatch.MetricAlarm(', idAt);
  if (callStart < 0) return '';
  const open = source.indexOf('(', callStart + 'new aws.cloudwatch.MetricAlarm'.length);
  if (open < 0) return '';

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return stripComments(source.slice(callStart, i + 1));
  }
  return '';
}

/** Removes a `metricQueries: [ ... ]` array so nested metric fields cannot pass for alarm fields. */
function withoutMetricQueries(block: string): string {
  const start = block.indexOf('metricQueries: [');
  if (start < 0) return block;
  let depth = 0;
  for (let i = block.indexOf('[', start); i < block.length; i++) {
    if (block[i] === '[') depth++;
    else if (block[i] === ']' && --depth === 0) return block.slice(0, start) + block.slice(i + 1);
  }
  return block;
}

const ALARMS = [
  { id: 'DlqAlarmHandlerDlqMessages', source: DLQ_ALARMS, kind: 'messages' },
  { id: 'DlqAlarmHandlerDlqAge', source: DLQ_ALARMS, kind: 'age' },
  { id: 'WafAlarmSlackHandlerDlqMessages', source: WAF, kind: 'messages' },
  { id: 'WafAlarmSlackHandlerDlqAge', source: WAF, kind: 'age' },
] as const;

describe('out-of-band DLQ alarms', () => {
  for (const { id, source, kind } of ALARMS) {
    describe(id, () => {
      const alarm = alarmBlock(source, id);

      it('is found', () => {
        expect(alarm).not.toBe('');
      });

      it('declares one missing-data policy, and it holds the state', () => {
        // Exactly one occurrence, so a deleted literal cannot be covered by a neighbour's.
        expect(alarm.match(/treatMissingData:/g) ?? []).toHaveLength(1);
        expect(alarm).toMatch(/treatMissingData: 'ignore'/);
      });

      it('stays on the AWS/SQS namespace', () => {
        expect(alarm).toMatch(/namespace: 'AWS\/SQS'/);
      });

      if (kind === 'messages') {
        it('watches the DLQ message count as a plain metric alarm', () => {
          const fields = withoutMetricQueries(alarm);
          expect(fields).toMatch(/metricName: 'ApproximateNumberOfMessagesVisible'/);
          expect(fields).not.toMatch(/metricQueries/);
          expect(fields).toMatch(/dimensions: \{ QueueName:/);
        });
      } else {
        it('scores an empty queue as 0 so a drained DLQ still reaches OK', () => {
          expect(alarm).toMatch(/expression: 'IF\(visible > 0, age, 0\)'/);
          expect(alarm).toMatch(/metricName: 'ApproximateNumberOfMessagesVisible'/);
          expect(alarm).toMatch(/metricName: 'ApproximateAgeOfOldestMessage'/);
          expect(alarm).toMatch(/returnData: true/);

          // Metric math forbids the alarm-level metric fields; CloudWatch rejects the deploy.
          const fields = withoutMetricQueries(alarm);
          expect(fields).not.toMatch(/metricName:/);
          expect(fields).not.toMatch(/dimensions:/);
          expect(fields).not.toMatch(/statistic:/);
        });
      }
    });
  }
});

describe('the fleet alarms', () => {
  const createDlqAlarms = stripComments(DLQ_ALARMS.match(/function createDlqAlarms\([\s\S]*?\n\}/)?.[0] ?? '');

  it('creates a pair for every descriptor', () => {
    expect(stripComments(DLQ_ALARMS)).toMatch(/for \(const dlq of DLQ_DESCRIPTORS\) \{\s*createDlqAlarms\(dlq\);\s*\}/);
  });

  it('keeps the drain path: OK and ALARM go to the shared topic unconditionally', () => {
    expect(createDlqAlarms).not.toBe('');
    for (const action of ['alarmActions', 'okActions']) {
      // One whole-line assignment per action: a commented-out or conditional wiring
      // (`...(cond ? { okActions: [...] } : {})`) matches neither shape.
      expect(createDlqAlarms.match(new RegExp(`${action}:`, 'g')) ?? []).toHaveLength(1);
      expect(createDlqAlarms).toMatch(new RegExp(`^ {2,8}${action}: \\[dlqAlarmTopic!\\.arn\\],$`, 'm'));
    }
  });
});
