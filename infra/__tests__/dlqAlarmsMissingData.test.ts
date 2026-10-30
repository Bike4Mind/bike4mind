/**
 * @vitest-environment node
 *
 * Pins the out-of-band DLQ alarms. `treatMissingData: 'ignore'` holds the alarm state across a
 * skipped SQS datapoint, where 'notBreaching' resolved it to OK and the next datapoint re-paged;
 * the age alarms read the age metric through the shared IF(visible > 0, age, 0) metric math
 * (`buildDlqAgeMetricQueries`), so a drained DLQ normally scores 0 off the visible count and
 * reaches OK.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const ALARM_CALL = 'new aws.cloudwatch.MetricAlarm(';

/** Index just past the string literal starting at `start` (single, double or backtick quoted). */
function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === quote) return i + 1;
  }
  return source.length;
}

/**
 * Source with every comment removed and string literals kept verbatim, so a commented-out field
 * cannot satisfy a match and a paren or slash inside a description is never read as code.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(source, i);
      out += source.slice(i, end);
      i = end;
    } else if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      out += ' ';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const DLQ_ALARMS = stripComments(read('infra/dlqAlarms.ts'));
const WAF = stripComments(read('infra/waf.ts'));
const ACCOUNT_CREATION = stripComments(read('infra/accountCreationAlarms.ts'));

/**
 * One `new aws.cloudwatch.MetricAlarm(...)` call, from its opening paren to the balanced closing
 * one. Balanced rather than a formatting-exact terminator, so a block can never silently resolve
 * to its neighbour's text or run on into the surrounding function; string literals are skipped so
 * a paren inside a description cannot skew the depth. Throws when a call does not balance, so a
 * malformed alarm fails the suite instead of vanishing from it.
 */
function balancedCall(source: string, callStart: number): string {
  let depth = 0;
  for (let i = callStart + ALARM_CALL.length - 1; i < source.length;) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return source.slice(callStart, i + 1);
    i++;
  }
  throw new Error(`unbalanced MetricAlarm call at offset ${callStart}: ${source.slice(callStart, callStart + 80)}`);
}

/** Every alarm call in a source, so no alarm can sit outside the guard by omission. */
function alarmBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (let at = source.indexOf(ALARM_CALL); at >= 0; at = source.indexOf(ALARM_CALL, at + 1)) {
    const block = balancedCall(source, at);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** The alarm whose logical resource name is `id`, e.g. 'DlqAlarmHandlerDlqAge'. */
function alarmBlock(source: string, id: string): string {
  const idAt = source.indexOf(`'${id}'`);
  if (idAt < 0) return '';
  const callStart = source.lastIndexOf(ALARM_CALL, idAt);
  return callStart < 0 ? '' : balancedCall(source, callStart);
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

      if (kind === 'messages') {
        it('watches the DLQ message count as a plain AWS/SQS metric alarm', () => {
          // Asserted on the whole alarm: a messages alarm that grew metric math would stop being
          // a plain metric alarm.
          expect(alarm).not.toMatch(/metricQueries/);
          expect(alarm).toMatch(/namespace: 'AWS\/SQS'/);
          expect(alarm).toMatch(/metricName: 'ApproximateNumberOfMessagesVisible'/);
          expect(alarm).toMatch(/dimensions: \{ QueueName:/);
        });
      } else {
        it('reads the age through the shared metric math, bound to its own queue', () => {
          // The query shape itself is unit-tested in b4m-core/infra/src/__tests__/dlqAlarmSpecs.test.ts.
          expect(alarm).toMatch(/metricQueries: buildDlqAgeMetricQueries\(60, \{ QueueName: \w+\.name \}\),/);

          // Metric math forbids the alarm-level metric fields; CloudWatch rejects the deploy.
          expect(alarm).not.toMatch(/metricName:/);
          expect(alarm).not.toMatch(/dimensions:/);
          expect(alarm).not.toMatch(/statistic:/);
        });
      }
    });
  }
});

describe('every AWS/SQS alarm in the out-of-band files', () => {
  const sqsAlarms = [...alarmBlocks(DLQ_ALARMS), ...alarmBlocks(WAF), ...alarmBlocks(ACCOUNT_CREATION)].filter(block =>
    /namespace: 'AWS\/SQS'|buildDlqAgeMetricQueries\(/.test(block)
  );
  const idOf = (block: string) => block.match(/MetricAlarm\(\s*'([^']+)'/)?.[1] ?? '<unnamed>';

  it('scans the alarms the per-alarm cases pin, plus any added later', () => {
    expect(sqsAlarms.map(idOf)).toEqual(expect.arrayContaining(ALARMS.map(alarm => alarm.id)));
  });

  it('declares exactly one missing-data policy per alarm, and it holds state', () => {
    expect(sqsAlarms.map(block => [idOf(block), ...(block.match(/treatMissingData: '[a-zA-Z]+'/g) ?? [])])).toEqual(
      sqsAlarms.map(block => [idOf(block), "treatMissingData: 'ignore'"])
    );
  });
});

describe('the fleet alarms', () => {
  const createDlqAlarms = DLQ_ALARMS.match(/function createDlqAlarms\([\s\S]*?\n\}/)?.[0] ?? '';

  it('creates a pair for every descriptor', () => {
    expect(DLQ_ALARMS).toMatch(/for \(const dlq of ALARMED_DLQS\) \{\s*createDlqAlarms\(dlq\);\s*\}/);
  });

  it('alarms the conditional card verification recovery dead letter without a replay source', () => {
    expect(DLQ_ALARMS).toMatch(
      /if \(cardVerificationRecoveryDLQ\) \{\s*createDlqAlarms\(\{\s*label: 'card-verification-recovery',\s*displayName: 'Card Verification Recovery',\s*application: 'Billing',\s*queue: cardVerificationRecoveryDLQ,\s*\}\);/
    );
  });

  it('alarms the contributed DLQs through the same loop as the core ones', () => {
    // A contributed DLQ outside ALARMED_DLQS would get no alarm, or one built without the shared specs.
    const alarmed = DLQ_ALARMS.match(/const ALARMED_DLQS: InfraDlqDescriptor\[\] = \[[\s\S]*?\n\];/)?.[0] ?? '';
    expect(alarmed).toMatch(/^ {2}\.\.\.DLQ_DESCRIPTORS,$/m);
    expect(alarmed).toMatch(/^ {2}\.\.\.Object\.values\(contributedQueues\)\.map\(/m);
  });

  it('instantiates every spec the shared builder returns', () => {
    // Pinning only the descriptor loop would let the inner loop narrow to one spec, dropping
    // the fleet age alarms - the whole point of the metric-math shape.
    expect(createDlqAlarms).toContain(
      'for (const spec of buildDlqAlarmSpecs(dlq, { appName: $app.name, stage: $app.stage }))'
    );
  });

  it('binds the queue dimensions through the shared helper', () => {
    // An age alarm is metric math, so alarm-level `dimensions` would leave its input metrics
    // queue-less; the helper is what moves them onto each query.
    expect(createDlqAlarms).toMatch(/\.\.\.bindDlqAlarmDimensions\(spec, dimensions\),/);
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
