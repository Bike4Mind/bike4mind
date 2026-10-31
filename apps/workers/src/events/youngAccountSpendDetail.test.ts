import { describe, it, expect, vi, afterEach } from 'vitest';
import { GetQueryResultsCommand, StartQueryCommand, StopQueryCommand } from '@aws-sdk/client-cloudwatch-logs';

import {
  aggregateSpenders,
  alarmWindow,
  fetchYoungAccountSpenders,
  formatAccountAge,
  formatSpenderLine,
  formatYoungAccountSpenders,
  SECTION_TITLE,
  TOP_ACCOUNT_LIMIT,
  YOUNG_ACCOUNT_SPEND_QUERY,
  youngAccountSpendSection,
  type LogsClient,
  type YoungAccountSpender,
} from './youngAccountSpendDetail';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';

const hourly: CloudWatchAlarmPayload = {
  AlarmName: 'bike4mind-dev-young-account-spend-rate',
  NewStateValue: 'ALARM',
  OldStateValue: 'OK',
  NewStateReason:
    'Threshold Crossed: 1 datapoint [2.592969 (31/10/26 00:17:00)] was greater than or equal to the threshold (2.0).',
  StateChangeTime: '2026-10-31T01:18:12.000+0000',
  Region: 'us-east-2',
  Trigger: { Period: 3600, EvaluationPeriods: 1, Threshold: 2 },
};

const windowEnd = new Date('2026-10-31T01:17:00.000Z');

const row = (fields: Record<string, string>) => Object.entries(fields).map(([field, value]) => ({ field, value }));

const rows = [
  row({ userId: 'u1', model: 'gpt-5.6-sol', spend: '1.5153', calls: '36', createdAt: '2026-10-30T22:17:00.000Z' }),
  row({ userId: 'u2', model: 'claude-opus-5-5', spend: '1.0301', calls: '33', createdAt: '2026-10-28T01:17:00.000Z' }),
  row({ userId: 'u1', model: 'claude-haiku-4-5', spend: '0.03847', calls: '6', createdAt: '2026-10-30T22:17:00.000Z' }),
  row({ userId: 'u3', model: 'gpt-4.1-mini', spend: '0.009098', calls: '8' }),
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('alarmWindow', () => {
  it('spans the breaching datapoints the reason lists', () => {
    expect(alarmWindow(hourly)).toEqual({
      start: new Date('2026-10-31T00:17:00.000Z'),
      end: windowEnd,
    });
  });

  it('runs from the oldest breaching datapoint to the end of the newest', () => {
    const window = alarmWindow({
      ...hourly,
      NewStateReason:
        'Threshold Crossed: 2 datapoints [4.0 (31/10/26 00:10:00), 3.5 (31/10/26 00:05:00)] were greater than or equal to the threshold (3.0).',
      Trigger: { Period: 300, EvaluationPeriods: 2, Threshold: 3 },
    });
    expect(window).toEqual({ start: new Date('2026-10-31T00:05:00.000Z'), end: new Date('2026-10-31T00:15:00.000Z') });
  });

  it('falls back to the evaluation span ending at the state change', () => {
    const window = alarmWindow({
      ...hourly,
      NewStateReason: 'Set by hand',
      Trigger: { Period: 300, EvaluationPeriods: 2 },
    });
    expect(window).toEqual({ start: new Date('2026-10-31T01:08:12.000Z'), end: new Date('2026-10-31T01:18:12.000Z') });
  });

  it('is undefined without a period to size the window', () => {
    expect(alarmWindow({ ...hourly, NewStateReason: 'Set by hand', Trigger: undefined })).toBeUndefined();
  });
});

describe('aggregateSpenders', () => {
  it('sums the per-model rows into accounts, highest spend first, models sorted within', () => {
    const spenders = aggregateSpenders(rows);
    expect(spenders.map(s => s.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(spenders[0]).toEqual({
      userId: 'u1',
      usd: 1.5153 + 0.03847,
      calls: 42,
      accountCreatedAt: new Date('2026-10-30T22:17:00.000Z'),
      models: [
        { model: 'gpt-5.6-sol', usd: 1.5153 },
        { model: 'claude-haiku-4-5', usd: 0.03847 },
      ],
    });
    expect(spenders[2].accountCreatedAt).toBeUndefined();
  });

  it('skips rows with no account id and tolerates junk numbers', () => {
    const spenders = aggregateSpenders([
      row({ userId: '', model: 'x', spend: '9', calls: '1' }),
      row({ userId: 'u9', model: 'x', spend: 'nope', calls: '1', createdAt: 'not a date' }),
    ]);
    expect(spenders).toEqual([{ userId: 'u9', usd: 0, calls: 1, models: [{ model: 'x', usd: 0 }] }]);
  });
});

describe('formatAccountAge', () => {
  it('reads in minutes, hours, then days', () => {
    const at = new Date('2026-10-31T01:17:00.000Z');
    expect(formatAccountAge(new Date('2026-10-31T01:05:00.000Z'), at)).toBe('12 min old');
    expect(formatAccountAge(new Date('2026-10-30T22:17:00.000Z'), at)).toBe('3 h old');
    expect(formatAccountAge(new Date('2026-10-28T01:17:00.000Z'), at)).toBe('3 d old');
    expect(formatAccountAge(undefined, at)).toBe('age unknown');
  });
});

describe('formatYoungAccountSpenders', () => {
  const spenders = aggregateSpenders(rows);

  it('lists id, spend, calls, age, model mix and an admin link per account', () => {
    const text = formatYoungAccountSpenders(spenders, { windowEnd, appUrl: 'https://app.example.com/' });
    const lines = text.split('\n');
    expect(lines[0]).toBe(SECTION_TITLE);
    expect(lines[1]).toBe(
      '1. `u1` 1.55 USD in 42 calls, 3 h old: gpt-5.6-sol 1.52, claude-haiku-4-5 0.04  <https://app.example.com/admin/users/u1|admin>'
    );
    expect(lines[2]).toContain('`u2` 1.03 USD in 33 calls, 3 d old: claude-opus-5-5 1.03');
    expect(lines[3]).toContain('`u3` 0.0091 USD in 8 calls, age unknown: gpt-4.1-mini 0.0091');
    expect(text).not.toMatch(/@|mailto/);
  });

  it('omits the link without an app url and escapes markup in ids and models', () => {
    const line = formatSpenderLine(
      { userId: 'a<b>&c', usd: 1, calls: 1, models: [{ model: 'm<1>', usd: 1 }] },
      1,
      windowEnd,
      undefined
    );
    expect(line).toBe('1. `a&lt;b&gt;&amp;c` 1.00 USD in 1 call, age unknown: m&lt;1&gt; 1.00');
  });

  it('caps the list at five accounts and three models each, and says how many more', () => {
    const many: YoungAccountSpender[] = Array.from({ length: 8 }, (_, i) => ({
      userId: `u${i}`,
      usd: 8 - i,
      calls: 1,
      models: Array.from({ length: 5 }, (_, m) => ({ model: `m${m}`, usd: 1 - m / 10 })),
    }));
    const text = formatYoungAccountSpenders(many, { windowEnd });
    const lines = text.split('\n');
    expect(lines).toHaveLength(TOP_ACCOUNT_LIMIT + 2);
    expect(lines[1]).toContain('m0 1.00, m1 0.90, m2 0.80 (+2 more)');
    expect(lines[lines.length - 1]).toBe('and 3 more accounts');
  });

  it('stays under the Slack section limit by dropping trailing lines', () => {
    const wide: YoungAccountSpender[] = Array.from({ length: 5 }, (_, i) => ({
      userId: `u${i}`,
      usd: 5 - i,
      calls: 1,
      models: [{ model: 'm'.repeat(900), usd: 1 }],
    }));
    const text = formatYoungAccountSpenders(wide, { windowEnd });
    expect(text.length).toBeLessThanOrEqual(2900);
    expect(text.split('\n').length).toBeLessThan(6);
  });

  it('says so when no line named an account', () => {
    expect(formatYoungAccountSpenders([], { windowEnd })).toBe(
      `${SECTION_TITLE}\nNo account is named on the spend lines for this window.`
    );
  });
});

type Sent = { constructor: { name: string }; input: Record<string, unknown> };

function client(responses: Array<Record<string, unknown> | Error>): LogsClient & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: vi.fn(async (command: Sent) => {
      sent.push(command);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? {};
    }) as unknown as LogsClient['send'],
  };
}

describe('fetchYoungAccountSpenders', () => {
  const window = { start: new Date('2026-10-31T00:17:00.000Z'), end: windowEnd };

  it('starts the query over the window, polls until complete, and aggregates', async () => {
    const logs = client([{ queryId: 'q1' }, { status: 'Running' }, { status: 'Complete', results: rows }]);
    const sleep = vi.fn(async () => {});
    const spenders = await fetchYoungAccountSpenders(window, { logGroup: '/sst/chat', client: logs, sleep });
    expect(spenders.map(s => s.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(logs.sent[0]).toBeInstanceOf(StartQueryCommand);
    expect(logs.sent[0].input).toMatchObject({
      logGroupName: '/sst/chat',
      startTime: 1793405820,
      endTime: 1793409420,
      queryString: YOUNG_ACCOUNT_SPEND_QUERY,
    });
    expect(logs.sent[1]).toBeInstanceOf(GetQueryResultsCommand);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws when the query fails', async () => {
    const logs = client([{ queryId: 'q1' }, { status: 'Failed' }]);
    await expect(fetchYoungAccountSpenders(window, { logGroup: '/sst/chat', client: logs })).rejects.toThrow(
      'Logs Insights query failed'
    );
  });

  it('stops the query and throws at the deadline', async () => {
    const logs = client([{ queryId: 'q1' }, { status: 'Running' }, { status: 'Running' }, {}]);
    let now = 0;
    const sleep = vi.fn(async () => {
      now += 10_000;
    });
    await expect(
      fetchYoungAccountSpenders(window, {
        logGroup: '/sst/chat',
        client: logs,
        sleep,
        deadlineMs: 15_000,
        now: () => now,
      })
    ).rejects.toThrow('did not finish in time');
    expect(logs.sent[logs.sent.length - 1]).toBeInstanceOf(StopQueryCommand);
  });
});

describe('youngAccountSpendSection', () => {
  it('renders the accounts for the alarm window using the configured log group', async () => {
    vi.stubEnv('LLM_SPEND_LOG_GROUP', '/sst/chat');
    const fetch = vi.fn(async () => aggregateSpenders(rows));
    const text = await youngAccountSpendSection(hourly, { appUrl: 'https://app.example.com', fetch });
    expect(fetch).toHaveBeenCalledWith(
      { start: new Date('2026-10-31T00:17:00.000Z'), end: windowEnd },
      { logGroup: '/sst/chat' }
    );
    expect(text).toContain('<https://app.example.com/admin/users/u1|admin>');
  });

  it('says why when no log group is configured, and never queries', async () => {
    vi.stubEnv('LLM_SPEND_LOG_GROUP', '');
    const fetch = vi.fn(async () => []);
    expect(await youngAccountSpendSection(hourly, { fetch })).toBe(
      `${SECTION_TITLE}\nNot available: the alarm relay has no spend log group configured.`
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says why when the alarm carries no window', async () => {
    const fetch = vi.fn(async () => []);
    const text = await youngAccountSpendSection(
      { ...hourly, NewStateReason: 'Set by hand', Trigger: undefined },
      { logGroup: '/sst/chat', fetch }
    );
    expect(text).toBe(`${SECTION_TITLE}\nNot available: the alarm did not say which window breached.`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('degrades to a note, and logs, when the query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(async () => {
      throw new Error('AccessDeniedException <denied>');
    });
    const text = await youngAccountSpendSection(hourly, { logGroup: '/sst/chat', fetch });
    expect(text).toBe(
      `${SECTION_TITLE}\nCould not be loaded (AccessDeniedException &lt;denied&gt;). Query the ChatCompletion log group for the window instead.`
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bike4mind-dev-young-account-spend-rate'));
  });
});
