import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

import {
  aggregateProviderSpend,
  formatProviderSpend,
  providerSpendQuery,
  providerSpendSection,
  SECTION_TITLE,
  type fetchProviderSpend,
} from './providerSpendDetail';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';

const hourly: CloudWatchAlarmPayload = {
  AlarmName: 'bike4mind-production-llm-spend-hourly-openai',
  NewStateValue: 'ALARM',
  OldStateValue: 'OK',
  NewStateReason:
    'Threshold Crossed: 1 datapoint [21.34 (27/10/26 18:08:00)] was greater than or equal to the threshold (20.0).',
  StateChangeTime: '2026-10-27T19:09:12.000+0000',
  Region: 'us-east-2',
  Trigger: { Period: 3600, EvaluationPeriods: 1, Threshold: 20, Dimensions: [{ name: 'Provider', value: 'openai' }] },
};

const windowEnd = new Date('2026-10-27T19:08:00.000Z');

const row = (fields: Record<string, string>) => Object.entries(fields).map(([field, value]) => ({ field, value }));

const rows = [
  row({
    userId: 'u1',
    model: 'gpt-5.6-sol',
    source: 'chat',
    isYoungAccount: '0',
    spend: '15.00',
    calls: '120',
    createdAt: '2026-01-02T00:00:00.000Z',
  }),
  row({
    userId: 'u1',
    model: 'gpt-4.1-mini',
    source: 'api',
    isYoungAccount: '0',
    spend: '2.00',
    calls: '40',
    createdAt: '2026-01-02T00:00:00.000Z',
  }),
  row({
    userId: 'u2',
    model: 'gpt-5.6-sol',
    source: 'chat',
    isYoungAccount: '1',
    spend: '3.34',
    calls: '30',
    createdAt: '2026-10-27T10:08:00.000Z',
  }),
  row({ model: 'gpt-4.1-mini', source: 'system', isYoungAccount: 'false', spend: '1.00', calls: '5' }),
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('providerSpendQuery', () => {
  it('filters to the settled lines of one provider and groups by account, model, source and age', () => {
    const query = providerSpendQuery('openai');
    expect(query).toContain('filter message = "llm-usage-settled" and provider = "openai"');
    expect(query).toContain('by userId, model, source, isYoungAccount');
    expect(query).toContain('sum(usd) as spend');
  });
});

describe('aggregateProviderSpend', () => {
  it('sums totals, the young share and the per-model, source and account lists', () => {
    const breakdown = aggregateProviderSpend(rows);
    expect(breakdown.total.usd).toBeCloseTo(21.34);
    expect(breakdown.total.calls).toBe(195);
    expect(breakdown.young.usd).toBeCloseTo(3.34);
    expect(breakdown.models.map(m => m.model)).toEqual(['gpt-5.6-sol', 'gpt-4.1-mini']);
    expect(breakdown.models[0].usd).toBeCloseTo(18.34);
    expect(breakdown.sources.map(s => s.source)).toEqual(['chat', 'api', 'system']);
    expect(breakdown.accounts.map(a => [a.userId, a.young])).toEqual([
      ['u1', false],
      ['u2', true],
      ['(no account)', false],
    ]);
    expect(breakdown.accounts[0].usd).toBeCloseTo(17);
    expect(breakdown.truncated).toBe(false);
  });
});

describe('formatProviderSpend', () => {
  it('leads with the young-account share, then sources, models and the top accounts', () => {
    const text = formatProviderSpend(aggregateProviderSpend(rows), {
      windowEnd,
      appUrl: 'https://app.example.com',
      measuredUsd: 21.34,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe(SECTION_TITLE);
    expect(lines[1]).toBe('Accounts under 7 days old: *3.34 of 21.34 USD (16%)*');
    expect(lines[2]).toBe('By source: chat 18.34 (86%), api 2.00 (9%), system 1.00 (5%)');
    expect(lines[3]).toBe('Top models: gpt-5.6-sol 18.34 (86%), gpt-4.1-mini 3.00 (14%)');
    expect(lines[5]).toBe('1. `u1` 17.00 USD in 160 calls, 299 d old  <https://app.example.com/admin/users/u1|admin>');
    expect(lines[6]).toBe(
      '2. `u2` 3.34 USD in 30 calls, 9 h old (new account)  <https://app.example.com/admin/users/u2|admin>'
    );
    expect(lines[7]).toBe('3. no account on the line: 1.00 USD in 5 calls');
    expect(text).not.toContain('add up to');
  });

  it('says when the lines fall short of the measured spend', () => {
    const text = formatProviderSpend(aggregateProviderSpend(rows.slice(0, 1)), { windowEnd, measuredUsd: 21.34 });
    expect(text).toContain('These lines add up to 15.00 of the 21.34 USD measured');
  });

  it('says so when no line was found', () => {
    expect(formatProviderSpend(aggregateProviderSpend([]), { windowEnd })).toContain('No spend lines were found');
  });
});

describe('providerSpendSection', () => {
  const logGroups = ['/aws/lambda/chat'];

  it('queries the provider and window the alarm measured', async () => {
    const fetch = vi.fn<typeof fetchProviderSpend>().mockResolvedValue(aggregateProviderSpend(rows));
    const text = await providerSpendSection(hourly, { logGroups, fetch });
    expect(fetch).toHaveBeenCalledWith(
      'openai',
      { start: new Date('2026-10-27T18:08:00.000Z'), end: windowEnd },
      { logGroups }
    );
    expect(text).toContain('Accounts under 7 days old');
  });

  it('reads the log groups from the relay env', async () => {
    vi.stubEnv('LLM_SPEND_LOG_GROUPS', ' /a , /b ');
    const fetch = vi.fn<typeof fetchProviderSpend>().mockResolvedValue(aggregateProviderSpend(rows));
    await providerSpendSection(hourly, { fetch });
    expect(fetch.mock.calls[0][2]).toEqual({ logGroups: ['/a', '/b'] });
  });

  it('degrades to a note without log groups, provider or window', async () => {
    const fetch = vi.fn<typeof fetchProviderSpend>();
    expect(await providerSpendSection(hourly, { logGroups: [], fetch })).toContain('no spend log group');
    expect(
      await providerSpendSection(
        { ...hourly, AlarmName: 'bike4mind-production-llm-spend-hourly', Trigger: { Period: 3600 } },
        { logGroups, fetch }
      )
    ).toContain('does not name a provider');
    expect(
      await providerSpendSection(
        { ...hourly, NewStateReason: 'something else', StateChangeTime: '', Trigger: hourly.Trigger },
        { logGroups, fetch }
      )
    ).toContain('did not say which window');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never throws when the lookup fails', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn<typeof fetchProviderSpend>().mockRejectedValue(new Error('query timed out'));
    const text = await providerSpendSection(hourly, { logGroups, fetch });
    expect(text).toBe(
      `${SECTION_TITLE}\nCould not be loaded (query timed out). Open the LLM spend dashboard's by-model widget instead.`
    );
    expect(warn).toHaveBeenCalled();
  });
});
