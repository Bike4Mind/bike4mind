import { describe, it, expect, vi } from 'vitest';
import { GetInsightRuleReportCommand, type GetInsightRuleReportCommandOutput } from '@aws-sdk/client-cloudwatch';

vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/db-core', () => ({ connectDB: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  loadKeyringInBackground: vi.fn(),
  userRepository: { findIdsBySignupIp: vi.fn() },
}));
vi.mock('./relayDb', () => ({ connectRelayDb: vi.fn() }));

import {
  ACCOUNT_LIMIT,
  SECTION_TITLE,
  TOP_IP_LIMIT,
  inlineCode,
  fetchTopContributors,
  formatSignupAccounts,
  formatTopIps,
  formatTopPaths,
  refusedRequestBurstSection,
  reportWindow,
  type InsightReportClient,
} from './refusedRequestBurstDetail';
import { userRepository } from '@bike4mind/database';
import { connectRelayDb } from './relayDb';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';

const alarm: CloudWatchAlarmPayload = {
  AlarmName: 'bike4mind-production-refused-request-burst',
  NewStateValue: 'ALARM',
  OldStateValue: 'OK',
  NewStateReason: 'Threshold Crossed',
  StateChangeTime: '2026-11-17T12:30:00.000+0000',
};

const report = (contributors: [string[], number][]): Partial<GetInsightRuleReportCommandOutput> => ({
  Contributors: contributors.map(([Keys, ApproximateAggregateValue]) => ({
    Keys,
    ApproximateAggregateValue,
    Datapoints: [],
  })),
});

/** Answers each rule by name; a missing rule rejects like an AccessDenied would. */
function clientFor(reports: Record<string, Partial<GetInsightRuleReportCommandOutput>>) {
  const send = vi.fn(async (command: GetInsightRuleReportCommand) => {
    const answer = reports[command.input.RuleName ?? ''];
    if (!answer) throw new Error(`no report for ${command.input.RuleName}`);
    return answer;
  });
  return { client: { send } as unknown as InsightReportClient, send };
}

const IP_RULE = 'app-production-refused-requests-by-ip';
const PATH_RULE = 'app-production-refused-requests-by-ip-path';

describe('reportWindow', () => {
  it('looks back two alarm windows from the state change', () => {
    expect(reportWindow(alarm)).toEqual({
      start: new Date('2026-11-17T12:00:00.000Z'),
      end: new Date('2026-11-17T12:30:00.000Z'),
    });
    expect(reportWindow({ ...alarm, StateChangeTime: 'not a date' })).toBeUndefined();
  });
});

describe('fetchTopContributors', () => {
  it('asks the rule for its top contributors over the window, highest count first', async () => {
    const { client, send } = clientFor({
      [IP_RULE]: report([
        [['198.51.100.2'], 12.4],
        [['198.51.100.1'], 180],
      ]),
    });
    const window = { start: new Date('2026-11-17T12:00:00Z'), end: new Date('2026-11-17T12:30:00Z') };
    expect(await fetchTopContributors(client, IP_RULE, window, TOP_IP_LIMIT)).toEqual([
      { keys: ['198.51.100.1'], count: 180 },
      { keys: ['198.51.100.2'], count: 12 },
    ]);
    expect(send.mock.calls[0][0].input).toMatchObject({
      RuleName: IP_RULE,
      StartTime: window.start,
      EndTime: window.end,
      MaxContributorCount: TOP_IP_LIMIT,
      OrderBy: 'Sum',
    });
  });
});

describe('formatting', () => {
  it('escapes caller-controlled values and keeps them on one inline code span', () => {
    expect(inlineCode('/api/x?<script>&`')).toBe("`/api/x?&lt;script&gt;&amp;'`");
    expect(inlineCode('a'.repeat(200))).toHaveLength(2 + 120 + 3);
  });

  it("lists only the top IP's paths", () => {
    const lines = formatTopPaths('198.51.100.1', [
      { keys: ['198.51.100.2', '/api/other'], count: 90 },
      { keys: ['198.51.100.1', '/api/identify'], count: 40 },
      { keys: ['198.51.100.1', '/api/admin/users'], count: 30 },
    ]);
    expect(lines).toEqual(['Paths from `198.51.100.1`:', '- `/api/identify`: 40', '- `/api/admin/users`: 30']);
  });

  it('links signup accounts to their admin page and says when there are more', () => {
    const ids = Array.from({ length: ACCOUNT_LIMIT + 1 }, (_, i) => `u${i}`);
    const line = formatSignupAccounts('198.51.100.1', ids, 'https://app.example.com');
    expect(line).toContain('<https://app.example.com/admin/users/u0|u0>');
    expect(line).not.toContain(`u${ACCOUNT_LIMIT}`);
    expect(line).toMatch(/\(and more\)\.$/);
    expect(formatSignupAccounts('198.51.100.1', [], undefined)).toBe(
      'Accounts that signed up from `198.51.100.1`: none.'
    );
  });
});

describe('refusedRequestBurstSection', () => {
  it('names the top IPs, the top IP paths and its signup accounts', async () => {
    const { client } = clientFor({
      [IP_RULE]: report([
        [['198.51.100.1'], 180],
        [['198.51.100.2'], 20],
      ]),
      [PATH_RULE]: report([
        [['198.51.100.1', '/api/identify'], 150],
        [['198.51.100.2', '/api/x'], 20],
      ]),
    });
    const findSignupAccountIds = vi.fn(async () => ['u1']);
    const text = await refusedRequestBurstSection(alarm, {
      ipRule: IP_RULE,
      ipPathRule: PATH_RULE,
      client,
      findSignupAccountIds,
    });
    expect(text.split('\n')).toEqual([
      SECTION_TITLE,
      'Last 30 minutes:',
      '- `198.51.100.1`: 180 refused',
      '- `198.51.100.2`: 20 refused',
      'Accounts that signed up from `198.51.100.1`: `u1`.',
      'Paths from `198.51.100.1`:',
      '- `/api/identify`: 150',
    ]);
    expect(findSignupAccountIds).toHaveBeenCalledWith('198.51.100.1', ACCOUNT_LIMIT + 1);
  });

  it('still posts the top IPs when the path report and the account lookup fail', async () => {
    const { client } = clientFor({ [IP_RULE]: report([[['198.51.100.1'], 180]]) });
    const text = await refusedRequestBurstSection(alarm, {
      ipRule: IP_RULE,
      ipPathRule: PATH_RULE,
      client,
      findSignupAccountIds: async () => {
        throw new Error('db down');
      },
    });
    expect(text).toContain('- `198.51.100.1`: 180 refused');
    expect(text).toContain(`could not be loaded (no report for ${PATH_RULE})`);
    expect(text).toContain('could not be checked (db down)');
  });

  it('degrades to a note without a rule, a state-change time or a readable report', async () => {
    const { client } = clientFor({});
    const findSignupAccountIds = vi.fn(async () => []);
    expect(await refusedRequestBurstSection(alarm, { client, findSignupAccountIds })).toContain(
      'no refused-request rule configured'
    );
    expect(
      await refusedRequestBurstSection(
        { ...alarm, StateChangeTime: '' },
        { ipRule: IP_RULE, client, findSignupAccountIds }
      )
    ).toContain('did not say when it changed state');
    expect(await refusedRequestBurstSection(alarm, { ipRule: IP_RULE, client, findSignupAccountIds })).toContain(
      `Could not be loaded (no report for ${IP_RULE})`
    );
    expect(findSignupAccountIds).not.toHaveBeenCalled();
  });

  it('skips the lookups when the report has no contributor yet', async () => {
    const { client } = clientFor({ [IP_RULE]: report([]) });
    const findSignupAccountIds = vi.fn(async () => []);
    const text = await refusedRequestBurstSection(alarm, { ipRule: IP_RULE, client, findSignupAccountIds });
    expect(text).toContain('No contributor in the window yet');
    expect(findSignupAccountIds).not.toHaveBeenCalled();
  });

  it('reads the rule names from the environment and looks accounts up in the database by default', async () => {
    const { client, send } = clientFor({
      [IP_RULE]: report([[['198.51.100.1'], 180]]),
      [PATH_RULE]: report([[['198.51.100.1', '/api/identify'], 150]]),
    });
    vi.stubEnv('REFUSED_REQUEST_IP_RULE', IP_RULE);
    vi.stubEnv('REFUSED_REQUEST_IP_PATH_RULE', PATH_RULE);
    vi.mocked(userRepository.findIdsBySignupIp).mockResolvedValue(['u9']);
    try {
      const text = await refusedRequestBurstSection(alarm, { client });
      expect(send.mock.calls.map(call => call[0].input.RuleName)).toEqual([IP_RULE, PATH_RULE]);
      expect(connectRelayDb).toHaveBeenCalled();
      expect(userRepository.findIdsBySignupIp).toHaveBeenCalledWith('198.51.100.1', undefined, ACCOUNT_LIMIT + 1);
      expect(text).toContain('`u9`');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('asks only the IP rule when no path rule is configured and says when a top IP has no paths', async () => {
    const { client, send } = clientFor({
      [IP_RULE]: report([[['198.51.100.1'], 180]]),
      [PATH_RULE]: report([[['198.51.100.2', '/api/x'], 5]]),
    });
    const findSignupAccountIds = vi.fn(async () => []);
    const withoutPaths = await refusedRequestBurstSection(alarm, { ipRule: IP_RULE, client, findSignupAccountIds });
    expect(send).toHaveBeenCalledTimes(1);
    expect(withoutPaths).not.toContain('Paths from');
    const noMatch = await refusedRequestBurstSection(alarm, {
      ipRule: IP_RULE,
      ipPathRule: PATH_RULE,
      client,
      findSignupAccountIds,
    });
    expect(noMatch).toContain('Paths from `198.51.100.1`: none in the fetched report.');
  });

  it('skips contributors with no key and keeps the accounts line when long paths overflow the section', async () => {
    expect(formatTopIps([{ keys: [], count: 1 }])).toEqual(['- ``: 1 refused']);
    const longPath = `/${'&'.repeat(119)}`;
    const { client } = clientFor({
      [IP_RULE]: report([[['198.51.100.1'], 180]]),
      [PATH_RULE]: report(
        Array.from({ length: 5 }, (_, i): [string[], number] => [['198.51.100.1', `${longPath}${i}`], 50 - i])
      ),
    });
    const text = await refusedRequestBurstSection(alarm, {
      ipRule: IP_RULE,
      ipPathRule: PATH_RULE,
      client,
      findSignupAccountIds: async () => ['u1'],
    });
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toContain('Accounts that signed up from `198.51.100.1`: `u1`.');
    expect(text).not.toMatch(/&[a-z]*$/);
  });
});
