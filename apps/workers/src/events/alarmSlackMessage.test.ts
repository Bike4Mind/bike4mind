import { describe, it, expect, vi } from 'vitest';
import {
  ADMIN_LINKS,
  ALARM_CATALOG,
  alarmSuffix,
  appUrlFromEnv,
  composeAlarmMessage,
  describeFields,
  describeReason,
  formatAlarmSlackMessage,
  formatDuration,
  lookupCatalog,
  normalizeMentionToken,
  parseMentionSetting,
  postAlarmToSlack,
  resolveAlarmWebhookUrl,
  type SlackAlarmMessage,
} from './alarmSlackMessage';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';

const sample: CloudWatchAlarmPayload = {
  AlarmName: 'bike4mind-production-signup-code-send-rate',
  AlarmDescription: 'Sign-in code email dispatches per hour at or above the configured ceiling',
  NewStateValue: 'ALARM',
  OldStateValue: 'OK',
  NewStateReason:
    'Threshold Crossed: 1 datapoint [10.0 (27/10/26 04:00:00)] was greater than or equal to the threshold (10.0).',
  StateChangeTime: '2026-10-27T05:00:58.488+0000',
  Region: 'us-east-2',
  Trigger: { Period: 3600, EvaluationPeriods: 1, Threshold: 10 },
};

const burst: CloudWatchAlarmPayload = {
  ...sample,
  AlarmName: 'bike4mind-production-signup-code-send-burst',
  NewStateReason:
    'Threshold Crossed: 1 datapoint [18.0 (27/10/26 12:34:00)] was greater than or equal to the threshold (15.0).',
  StateChangeTime: '2026-10-27T12:39:58.488+0000',
  Trigger: { Period: 300, EvaluationPeriods: 1, Threshold: 15 },
};

type Block = {
  type: string;
  text?: { type: string; text: string };
  fields?: { text: string }[];
  elements?: { text?: string | { text: string }; url?: string }[];
};
const topBlocks = (m: SlackAlarmMessage | null) => (m as SlackAlarmMessage).blocks as Block[];
const attachment = (m: SlackAlarmMessage | null) =>
  (m as SlackAlarmMessage).attachments?.[0] as {
    color: string;
    blocks: Block[];
  };
const bodyOf = (m: SlackAlarmMessage | null) => attachment(m).blocks;
const header = (m: SlackAlarmMessage | null) => topBlocks(m).find(b => b.type === 'header')?.text?.text;
const sectionText = (m: SlackAlarmMessage | null, label: string) =>
  bodyOf(m)
    .filter(b => b.type === 'section' && b.text)
    .map(b => b.text!.text)
    .find(t => t.startsWith(`*${label}*`));
const fieldsOf = (m: SlackAlarmMessage | null) =>
  bodyOf(m)
    .find(b => b.fields)
    ?.fields?.map(f => f.text) ?? [];
const buttons = (m: SlackAlarmMessage | null) =>
  bodyOf(m)
    .find(b => b.type === 'actions')
    ?.elements?.map(e => ({ label: (e.text as { text: string }).text, url: e.url })) ?? [];
const contextOf = (m: SlackAlarmMessage | null) =>
  (bodyOf(m).find(b => b.type === 'context')?.elements?.[0].text as string) ?? '';

describe('formatAlarmSlackMessage on production', () => {
  it('renders a page-level alarm with a siren header, red bar, numbers and buttons', () => {
    const message = formatAlarmSlackMessage(burst, 'production', { appUrl: 'https://app.example.com/' });
    expect(header(message)).toBe(':rotating_light: PRODUCTION ALARM: Sign-in code emails spiking');
    expect(attachment(message).color).toBe('#E01E5A');
    expect(fieldsOf(message)).toEqual([
      '*Measured*\n18 sign-in code emails',
      '*Ceiling*\n15',
      '*Window*\n5 minutes ending 12:39 UTC',
      '*Breaching since*\n12:34 UTC (6 min)',
    ]);
    expect(sectionText(message, 'What happened')).toBe(
      '*What happened*\n18 sign-in code emails in the 5 minutes ending 12:39 UTC; the ceiling is 15.'
    );
    expect(sectionText(message, 'Why it matters')).toContain('Automated signups are the usual cause.');
    expect(sectionText(message, 'What to do')).toContain('Check the admin signup activity');
    expect(buttons(message)).toEqual([
      {
        label: 'Open in CloudWatch',
        url: 'https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#alarmsV2:alarm/bike4mind-production-signup-code-send-burst',
      },
      { label: 'Signup activity', url: 'https://app.example.com/admin?tab=users&recentSignups=hour' },
      { label: 'WAF block list', url: 'https://app.example.com/admin?tab=security-dashboard' },
    ]);
    expect(contextOf(message)).toBe(
      'production  |  level page  |  bike4mind-production-signup-code-send-burst  |  12:39 UTC, 27 Oct'
    );
    expect(message?.text).toBe(
      ':rotating_light: PRODUCTION ALARM: Sign-in code emails spiking: 18 sign-in code emails in the 5 minutes ending 12:39 UTC; the ceiling is 15.'
    );
  });

  it('renders a warn-level alarm with an amber bar and no mention', () => {
    const message = formatAlarmSlackMessage(sample, 'production', { mention: 'channel' });
    expect(header(message)).toBe(':warning: Production warning: Sign-in code emails above the hourly ceiling');
    expect(attachment(message).color).toBe('#ECB22E');
    expect(topBlocks(message)).toHaveLength(1);
    expect(message?.text).not.toContain('<!channel>');
    expect(contextOf(message)).toContain('level warn');
  });

  it('renders an info-level alarm with a blue bar', () => {
    const message = composeAlarmMessage({
      stage: 'production',
      level: 'info',
      title: 'Something to know',
      sections: ['*What happened*\nA thing.'],
      context: ['production'],
      summary: 'A thing.',
    });
    expect(header(message)).toBe(':information_source: Production notice: Something to know');
    expect(attachment(message).color).toBe('#36C5F0');
  });

  it('renders a title with markup characters literally in the header and escaped in the fallback text', () => {
    const message = composeAlarmMessage({
      stage: 'production',
      level: 'info',
      title: 'Queue <a&b> stuck',
      sections: [],
      context: ['production'],
      summary: 'x',
    });
    expect(header(message)).toBe(':information_source: Production notice: Queue <a&b> stuck');
    expect(message.text).toContain('Queue &lt;a&amp;b&gt; stuck');
  });

  it('prepends the mention to page-level alarms only when a token is configured', () => {
    const off = formatAlarmSlackMessage(burst, 'production');
    expect(topBlocks(off)[0].type).toBe('header');
    expect(off?.text.startsWith(':rotating_light:')).toBe(true);

    const on = formatAlarmSlackMessage(burst, 'production', { mention: '<!subteam^S0123ABC>' });
    expect(topBlocks(on)[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '<!subteam^S0123ABC> production is paging' },
    });
    expect(on?.text.startsWith('<!subteam^S0123ABC> :rotating_light: PRODUCTION ALARM')).toBe(true);
  });

  it('extends the mention to warn-level alarms only when the setting says warn', () => {
    const pageOnly = formatAlarmSlackMessage(sample, 'production', { mention: 'here' });
    expect(topBlocks(pageOnly)[0].type).toBe('header');
    expect(pageOnly?.text).not.toContain('<!here>');

    const withWarn = formatAlarmSlackMessage(sample, 'production', { mention: 'here warn' });
    expect(topBlocks(withWarn)[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '<!here> production needs attention' },
    });
    expect(withWarn?.text.startsWith('<!here> :warning: Production warning')).toBe(true);

    const page = formatAlarmSlackMessage(burst, 'production', { mention: 'here warn' });
    expect(topBlocks(page)[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '<!here> production is paging' },
    });
  });

  it('never mentions on info-level alarms, whatever the setting', () => {
    const message = composeAlarmMessage({
      stage: 'production',
      level: 'info',
      title: 'Something to know',
      mention: 'channel warn',
      sections: ['*What happened*\nA thing.'],
      context: ['production'],
      summary: 'A thing.',
    });
    expect(topBlocks(message)[0].type).toBe('header');
    expect(message.text).not.toContain('<!channel>');
  });

  it('omits admin buttons without an app url and the CloudWatch button without a Region', () => {
    const message = formatAlarmSlackMessage({ ...burst, Region: undefined }, 'production');
    expect(bodyOf(message).find(b => b.type === 'actions')).toBeUndefined();
  });

  it('explains missing data and shows how long it has been missing', () => {
    const alarm = {
      ...sample,
      NewStateReason: 'Insufficient Data: 2 datapoints were missing',
      StateChangeTime: '2026-10-27T05:30:00.000+0000',
      Trigger: { Period: 300, EvaluationPeriods: 6 },
    };
    expect(describeReason(alarm)).toBe('No data arrived for 30 minutes, which counts as a failure for this alarm.');
    expect(describeFields(alarm, undefined, new Date('2026-10-27T05:30:00Z'))).toEqual([
      '*Missing data for*\n30 min',
      '*Breaching since*\n05:00 UTC (30 min)',
    ]);
    expect(describeReason({ ...alarm, Trigger: undefined })).toBe('No data arrived for a while.');
  });

  it('says floor for less-than alarms and uses a minutes period', () => {
    const alarm = {
      ...sample,
      NewStateReason:
        'Threshold Crossed: 2 datapoints [0.0 (27/10/26 04:00:00), 0.0 (27/10/26 04:05:00)] were less than the threshold (1.0).',
      Trigger: { Period: 300, EvaluationPeriods: 2 },
    };
    expect(describeReason(alarm, 'runs')).toBe('0 runs in the 5 minutes ending 04:10 UTC; the floor is 1.');
    const fields = describeFields(alarm, 'runs', new Date('2026-10-27T04:11:00Z'));
    expect(fields).toContain('*Floor*\n1');
    expect(fields).toContain('*Breaching since*\n04:00 UTC (11 min)');
  });

  it('rolls the bucket end over midnight', () => {
    const alarm = {
      ...sample,
      NewStateReason: 'Threshold Crossed: 1 datapoint [3.0 (27/10/26 23:00:00)] was greater than the threshold (2.0).',
      Trigger: { Period: 3600, EvaluationPeriods: 1 },
    };
    expect(describeReason(alarm, 'errors')).toBe('3 errors in the hour ending 00:00 UTC; the ceiling is 2.');
  });

  it('reports the newest datapoint whatever order the reason lists them in', () => {
    const alarm = {
      ...sample,
      NewStateReason:
        'Threshold Crossed: 2 datapoints [7.0 (27/10/26 04:05:00), 5.0 (27/10/26 04:00:00)] were greater than the threshold (3.0).',
      Trigger: { Period: 300, EvaluationPeriods: 2 },
    };
    expect(describeReason(alarm, 'errors')).toBe('7 errors in the 5 minutes ending 04:10 UTC; the ceiling is 3.');
  });

  it('prefers a real datapoint over the missing-data wording when a reason has both', () => {
    const alarm = {
      ...sample,
      NewStateReason:
        'Threshold Crossed: 1 out of the last 3 datapoints [5.0 (27/10/26 04:00:00)] was greater than the threshold (3.0) and 2 missing datapoints were treated as [Breaching].',
      Trigger: { Period: 300, EvaluationPeriods: 3 },
    };
    expect(describeReason(alarm, 'errors')).toBe('5 errors in the 5 minutes ending 04:05 UTC; the ceiling is 3.');
  });

  it('escapes Slack control characters in alarm-supplied text', () => {
    const message = formatAlarmSlackMessage(
      {
        ...sample,
        AlarmName: 'bike4mind-production-brand-new-thing',
        AlarmDescription: 'Errors <5% & latency > 2s',
        NewStateReason: 'Something <odd>',
      },
      'production'
    );
    expect(sectionText(message, 'What happened')).toContain('Something &lt;odd&gt;');
    expect(sectionText(message, 'Why it matters')).toContain('Errors &lt;5% &amp; latency &gt; 2s');
    expect(buttons(message)[0].label).toBe('Open in CloudWatch');
  });

  it('returns the raw reason for anything else and skips the numbers block', () => {
    const alarm = { ...sample, NewStateReason: 'Something odd' };
    expect(describeReason(alarm)).toBe('Something odd');
    expect(describeFields(alarm)).toEqual([]);
  });

  it('falls back to a suffix title, warn level and the alarm description for unknown alarms', () => {
    const message = formatAlarmSlackMessage(
      { ...sample, AlarmName: 'bike4mind-production-brand-new-thing', AlarmDescription: 'A brand new thing broke' },
      'production'
    );
    expect(header(message)).toBe(':warning: Production warning: Brand new thing');
    expect(sectionText(message, 'Why it matters')).toBe('*Why it matters*\nA brand new thing broke');
    expect(sectionText(message, 'What to do')).toBeUndefined();
    expect(contextOf(message)).toContain('level warn');
  });

  it('escapes markup characters in the resolved fallback text', () => {
    const message = formatAlarmSlackMessage(
      { ...sample, AlarmName: 'x-a<b&c-alarm', NewStateValue: 'OK', OldStateValue: 'ALARM' },
      'production'
    );
    expect(message?.text).toContain('a&lt;b&amp;c');
  });

  it('renders OK as a quiet green resolved message with no header', () => {
    const message = formatAlarmSlackMessage({ ...sample, NewStateValue: 'OK', OldStateValue: 'ALARM' }, 'production');
    expect(message?.text).toBe(':white_check_mark: Resolved: Sign-in code emails above the hourly ceiling');
    expect(topBlocks(message)).toEqual([]);
    expect(attachment(message).color).toBe('#2EB67D');
    expect(bodyOf(message)[0].text?.text).toBe(
      ':white_check_mark: *Resolved: Sign-in code emails above the hourly ceiling*\nproduction  |  back to normal at 05:00 UTC'
    );
    expect(contextOf(message)).toContain('bike4mind-production-signup-code-send-rate  |  <https://us-east-2.console');
  });

  it('returns null for INSUFFICIENT_DATA', () => {
    expect(formatAlarmSlackMessage({ ...sample, NewStateValue: 'INSUFFICIENT_DATA' }, 'production')).toBeNull();
  });
});

describe('formatAlarmSlackMessage on other stages', () => {
  const devBurst = { ...burst, AlarmName: 'bike4mind-dev-signup-code-send-burst' };

  it('labels stage dev as staging and keeps it secondary: grey bar, no siren, no mention even at page level', () => {
    const message = formatAlarmSlackMessage(devBurst, 'dev', { mention: 'channel' });
    expect(header(message)).toBe(':small_blue_diamond: staging alarm: Sign-in code emails spiking');
    expect(attachment(message).color).toBe('#9AA5B1');
    expect(topBlocks(message)).toHaveLength(1);
    expect(message?.text).not.toContain('<!channel>');
    expect(contextOf(message)).toBe(
      'staging  |  level page  |  bike4mind-dev-signup-code-send-burst  |  12:39 UTC, 27 Oct'
    );
  });

  it('treats staging and preview stages the same way', () => {
    const staging = formatAlarmSlackMessage(
      { ...burst, AlarmName: 'bike4mind-staging-signup-code-send-burst' },
      'staging'
    );
    expect(header(staging)).toBe(':small_blue_diamond: staging alarm: Sign-in code emails spiking');
    const preview = formatAlarmSlackMessage({ ...burst, AlarmName: 'bike4mind-pr-12-signup-code-send-burst' }, 'pr-12');
    expect(header(preview)).toBe(':small_blue_diamond: pr-12 alarm: Sign-in code emails spiking');
    expect(attachment(preview).color).toBe('#9AA5B1');
  });

  it('resolves on dev in the same quiet green shape', () => {
    const message = formatAlarmSlackMessage({ ...devBurst, NewStateValue: 'OK' }, 'dev');
    expect(attachment(message).color).toBe('#2EB67D');
    expect(bodyOf(message)[0].text?.text).toContain('staging  |  back to normal at 12:39 UTC');
  });

  it('drops warn-level alarms and their resolutions on stages other than production', () => {
    const devWarn = { ...sample, AlarmName: 'bike4mind-dev-signup-code-send-rate' };
    expect(formatAlarmSlackMessage(devWarn, 'dev')).toBeNull();
    expect(formatAlarmSlackMessage({ ...devWarn, NewStateValue: 'OK' }, 'dev')).toBeNull();
    expect(formatAlarmSlackMessage({ ...devWarn, AlarmName: 'bike4mind-pr-123-unknown' }, 'pr-123')).toBeNull();
    expect(formatAlarmSlackMessage(sample, 'production')).not.toBeNull();
  });
});

describe('ALARM_CATALOG', () => {
  it('only names admin links that exist', () => {
    for (const entry of Object.values(ALARM_CATALOG)) {
      for (const key of entry.links ?? []) expect(ADMIN_LINKS[key]).toBeDefined();
    }
  });

  it('pages for the alarms that need a human now', () => {
    expect(ALARM_CATALOG['signup-code-send-burst'].level).toBe('page');
    expect(ALARM_CATALOG['ungranted-credit-purchases'].level).toBe('page');
    expect(ALARM_CATALOG['signup-code-send-rate'].level).toBe('warn');
    expect(ALARM_CATALOG.SuccessfulSignups.level).toBe('page');
    expect(ALARM_CATALOG.NewAccountApiKeys.level).toBe('page');
    expect(ALARM_CATALOG['young-account-spend-rate'].level).toBe('page');
  });
});

describe('normalizeMentionToken', () => {
  it.each([undefined, '', '  ', 'off', 'none', 'false', '0', 'not-configured', 'junk', '<script>'])(
    'is off for %s',
    raw => {
      expect(normalizeMentionToken(raw)).toBeUndefined();
    }
  );

  it.each([
    ['channel', '<!channel>'],
    ['@channel', '<!channel>'],
    ['here', '<!here>'],
    ['everyone', '<!everyone>'],
    ['<!channel>', '<!channel>'],
    ['<!subteam^S0123ABC>', '<!subteam^S0123ABC>'],
    ['<@U0123ABC>', '<@U0123ABC>'],
    ['U0123ABC', '<@U0123ABC>'],
    ['W0123ABC', '<@W0123ABC>'],
    ['S0123ABC', '<!subteam^S0123ABC>'],
  ])('turns %s into %s', (raw, token) => {
    expect(normalizeMentionToken(raw)).toBe(token);
  });
});

describe('parseMentionSetting', () => {
  it.each([undefined, '', 'off', 'junk', 'off warn', 'warn'])('is off for %s', raw => {
    expect(parseMentionSetting(raw)).toBeUndefined();
  });

  it.each([
    ['here', { token: '<!here>', level: 'page' }],
    ['here warn', { token: '<!here>', level: 'warn' }],
    ['  channel   WARN ', { token: '<!channel>', level: 'warn' }],
    ['S0123ABC warn', { token: '<!subteam^S0123ABC>', level: 'warn' }],
    ['<!subteam^S0123ABC> page', { token: '<!subteam^S0123ABC>', level: 'page' }],
    ['here info', { token: '<!here>', level: 'page' }],
    ['here junk', { token: '<!here>', level: 'page' }],
  ])('reads %s as %o', (raw, expected) => {
    expect(parseMentionSetting(raw)).toEqual(expected);
  });
});

describe('formatDuration', () => {
  it('rounds to minutes and never reads as zero', () => {
    expect(formatDuration(5_000)).toBe('1 min');
    expect(formatDuration(6 * 60_000)).toBe('6 min');
    expect(formatDuration(60 * 60_000)).toBe('1 h');
    expect(formatDuration(70 * 60_000)).toBe('1 h 10 min');
  });
});

describe('appUrlFromEnv', () => {
  it('derives app.<apex> from SERVER_DOMAIN and is unset without it', () => {
    expect(appUrlFromEnv({ SERVER_DOMAIN: 'example.com' } as NodeJS.ProcessEnv)).toBe('https://app.example.com');
    expect(appUrlFromEnv({ SERVER_DOMAIN: '' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(appUrlFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('alarmSuffix', () => {
  it('strips app and stage', () => {
    expect(alarmSuffix('bike4mind-production-signup-code-send-rate', 'production')).toBe('signup-code-send-rate');
    expect(alarmSuffix('bike4mind-pr-12-ecs-task-failed-to-start', 'pr-12')).toBe('ecs-task-failed-to-start');
  });

  it('handles external WAF blocker names', () => {
    expect(alarmSuffix('waf-runtime-blocker-prod-no-successful-run', 'production')).toBe('no-successful-run');
    expect(alarmSuffix('waf-runtime-blocker-production-set-size', 'production')).toBe('set-size');
  });

  it('falls back to the whole name', () => {
    expect(alarmSuffix('something', 'production')).toBe('something');
  });
});

describe('lookupCatalog', () => {
  it('prefers an exact match', () => {
    expect(lookupCatalog('no-successful-run')).toBe(ALARM_CATALOG['no-successful-run']);
  });

  it('matches by suffix and prefers the longest key', () => {
    expect(lookupCatalog('slow-no-successful-run')).toBe(ALARM_CATALOG['slow-no-successful-run']);
    expect(lookupCatalog('model-discovery-no-successful-run')).toBe(ALARM_CATALOG['model-discovery-no-successful-run']);
    expect(lookupCatalog('x-cap-exceeded')).toBe(ALARM_CATALOG['cap-exceeded']);
  });

  it('matches by prefix', () => {
    expect(lookupCatalog('set-size-extra')).toBe(ALARM_CATALOG['set-size']);
  });

  it('returns undefined for unknown suffixes', () => {
    expect(lookupCatalog('nothing-like-it')).toBeUndefined();
  });

  it('generates dead-letter queue entries that name the queue', () => {
    const messages = lookupCatalog('dlq-billing-events-messages');
    expect(messages?.title).toBe('Background job failed: billing events');
    expect(messages?.links).toEqual(['dlq-replay']);
    const age = lookupCatalog('dlq-fab-file-chunk-age');
    expect(age?.title).toBe('Unhandled failure for over an hour: fab file chunk');
    expect(lookupCatalog('dlq-alarm-handler-dlq-messages')).toBe(ALARM_CATALOG['dlq-alarm-handler-dlq-messages']);
    expect(lookupCatalog('dlq-')).toBeUndefined();
  });

  it('covers the signup, spend and census alarms by exact name or provider prefix', () => {
    expect(lookupCatalog('SuccessfulSignups')).toBe(ALARM_CATALOG.SuccessfulSignups);
    expect(lookupCatalog('NewAccountApiKeys')).toBe(ALARM_CATALOG.NewAccountApiKeys);
    expect(lookupCatalog('llm-spend-rate-anthropic')).toBe(ALARM_CATALOG['llm-spend-rate']);
    expect(lookupCatalog('young-account-spend-rate')).toBe(ALARM_CATALOG['young-account-spend-rate']);
    expect(lookupCatalog('account-creation-metrics-missing')).toBe(ALARM_CATALOG['account-creation-metrics-missing']);
  });

  it('renders a dead-letter queue alarm with the queue name and the replay button', () => {
    const message = formatAlarmSlackMessage(
      { ...burst, AlarmName: 'bike4mind-production-dlq-release-notes-messages' },
      'production',
      { appUrl: 'https://app.example.com' }
    );
    expect(header(message)).toBe(':warning: Production warning: Background job failed: release notes');
    expect(buttons(message).map(b => b.label)).toContain('DLQ replay');
  });

  it('handles hand-shaped cap-exceeded messages with no Trigger', () => {
    const message = formatAlarmSlackMessage(
      {
        AlarmName: 'waf-runtime-blocker-prod-cap-exceeded',
        NewStateValue: 'ALARM',
        OldStateValue: 'OK',
        NewStateReason: 'Run found 80 new IPs',
        StateChangeTime: '2026-10-27T05:00:58.488+0000',
      },
      'production'
    );
    expect(header(message)).toBe(
      ':warning: Production warning: The WAF auto-blocker found more abusers than it is allowed to block'
    );
    expect(sectionText(message, 'What happened')).toBe('*What happened*\nRun found 80 new IPs');
  });
});

describe('resolveAlarmWebhookUrl', () => {
  const errors = { value: 'https://hooks.slack.example/errors' };

  it('uses the alarms url when set', () => {
    expect(
      resolveAlarmWebhookUrl({
        SLACK_ALARMS_WEBHOOK_URL: { value: 'https://hooks.slack.example/alarms' },
        SLACK_ERROR_REPORTING_WEBHOOK_URL: errors,
      })
    ).toBe('https://hooks.slack.example/alarms');
  });

  it('falls back when unset, empty or the placeholder', () => {
    const fallback = 'https://hooks.slack.example/errors';
    expect(resolveAlarmWebhookUrl({ SLACK_ERROR_REPORTING_WEBHOOK_URL: errors })).toBe(fallback);
    expect(
      resolveAlarmWebhookUrl({ SLACK_ALARMS_WEBHOOK_URL: { value: '' }, SLACK_ERROR_REPORTING_WEBHOOK_URL: errors })
    ).toBe(fallback);
    expect(
      resolveAlarmWebhookUrl({
        SLACK_ALARMS_WEBHOOK_URL: { value: 'not-configured' },
        SLACK_ERROR_REPORTING_WEBHOOK_URL: errors,
      })
    ).toBe(fallback);
  });
});

describe('postAlarmToSlack', () => {
  it('posts text, blocks and attachments, omits empty blocks, and throws on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);
    await postAlarmToSlack('https://hooks.slack.example/x', {
      text: 't',
      blocks: [{ type: 'divider' }],
      attachments: [{ color: '#000000', blocks: [] }],
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      text: 't',
      blocks: [{ type: 'divider' }],
      attachments: [{ color: '#000000', blocks: [] }],
    });

    await postAlarmToSlack('https://hooks.slack.example/x', { text: 'quiet', blocks: [] });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ text: 'quiet' });

    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Boom' });
    await expect(postAlarmToSlack('https://hooks.slack.example/x', { text: 't', blocks: [] })).rejects.toThrow(
      'Slack webhook failed: 500 Boom'
    );
  });
});

describe('fallback text', () => {
  it('escapes alarm-supplied text so a reason cannot smuggle a mention', () => {
    const message = formatAlarmSlackMessage({ ...sample, NewStateReason: '<!channel> & <odd>' }, 'production');
    expect(message?.text).toContain('&lt;!channel&gt; &amp; &lt;odd&gt;');
  });
});
