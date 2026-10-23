/**
 * @vitest-environment node
 *
 * Pins the out-of-band DLQ alarms. `treatMissingData: 'ignore'` holds the alarm state across a
 * skipped SQS datapoint, where 'notBreaching' resolved it to OK and the next datapoint re-paged;
 * the age alarms read the age metric through IF(visible > 0, age, 0) because SQS stops publishing
 * it on an empty queue, so a drained DLQ normally scores 0 off the visible count and reaches OK
 * (SQS reports that count while the queue is active; the post-deploy drain check confirms it).
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

/** The `{ ... }` objects of a `metricQueries: [...]` array, split on balanced braces. */
function metricQueries(block: string): string[] {
  const arrayAt = block.indexOf('metricQueries: [');
  if (arrayAt < 0) return [];
  const open = block.indexOf('[', arrayAt);

  let depth = 0;
  let end = -1;
  for (let i = open; i < block.length; i++) {
    if (block[i] === '[') depth++;
    else if (block[i] === ']' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];

  const queries: string[] = [];
  let braces = 0;
  let start = -1;
  for (let i = open; i < end; i++) {
    if (block[i] === '{') {
      if (braces++ === 0) start = i;
    } else if (block[i] === '}' && --braces === 0) {
      queries.push(block.slice(start, i + 1));
    }
  }
  return queries;
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
          // Asserted on the whole alarm, not on a stripped copy: a messages alarm that grew
          // metric math would stop being a plain metric alarm.
          expect(alarm).not.toMatch(/metricQueries/);
          expect(alarm).toMatch(/metricName: 'ApproximateNumberOfMessagesVisible'/);
          expect(alarm).toMatch(/dimensions: \{ QueueName:/);
        });
      } else {
        it('scores an empty queue as 0 so a drained DLQ still reaches OK', () => {
          // Pin the shape by identity: CloudWatch rejects an expression that names a query id
          // the alarm does not declare, or a second returnData query.
          const queries = metricQueries(alarm);
          expect(queries).toHaveLength(3);
          expect(queries.map(query => query.match(/id: '[^']+'/)?.[0])).toEqual([
            "id: 'visible'",
            "id: 'age'",
            "id: 'oldest'",
          ]);
          expect(queries.map(query => query.match(/returnData: (true|false)/)?.[0])).toEqual([
            'returnData: false',
            'returnData: false',
            'returnData: true',
          ]);
          expect(queries[2]).toMatch(/expression: 'IF\(visible > 0, age, 0\)'/);

          // Each input metric names its own queue; without this the alarm watches no queue.
          expect(queries[0]).toMatch(/metricName: 'ApproximateNumberOfMessagesVisible'/);
          expect(queries[0]).toMatch(/dimensions: \{ QueueName:/);
          expect(queries[1]).toMatch(/metricName: 'ApproximateAgeOfOldestMessage'/);
          expect(queries[1]).toMatch(/dimensions: \{ QueueName:/);

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

describe('every AWS/SQS alarm in the out-of-band files', () => {
  const sqsAlarms = [...alarmBlocks(DLQ_ALARMS), ...alarmBlocks(WAF)].filter(block =>
    /namespace: 'AWS\/SQS'/.test(block)
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
    expect(DLQ_ALARMS).toMatch(/for \(const dlq of DLQ_DESCRIPTORS\) \{\s*createDlqAlarms\(dlq\);\s*\}/);
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
