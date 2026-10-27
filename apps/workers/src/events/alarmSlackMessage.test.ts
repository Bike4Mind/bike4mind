import { describe, it, expect } from 'vitest';
import {
  ALARM_CATALOG,
  alarmSuffix,
  describeReason,
  formatAlarmSlackMessage,
  lookupCatalog,
  postAlarmToSlack,
  resolveAlarmWebhookUrl,
} from './alarmSlackMessage';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';
import { vi } from 'vitest';

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

type Block = { type: string; text?: { text: string }; elements?: { text: string }[] };
const blocksOf = (m: { blocks: unknown[] } | null) => (m as { blocks: Block[] }).blocks;

describe('formatAlarmSlackMessage', () => {
  it('renders the sample alarm in plain English', () => {
    const message = formatAlarmSlackMessage(sample, 'production');
    const blocks = blocksOf(message);
    expect(blocks[0].text?.text).toBe('🟡 Sign-in code emails above the hourly ceiling');
    expect(blocks[1].text?.text).toContain(
      '*What happened*\n10 sign-in code emails in the hour ending 05:00 UTC; the ceiling is 10.'
    );
    expect(blocks[1].text?.text).toContain('*Why it matters*');
    expect(blocks[1].text?.text).toContain('*What to do*');
    const context = blocks[2].elements?.[0].text ?? '';
    expect(context).toContain('production');
    expect(context).toContain('bike4mind-production-signup-code-send-rate');
    expect(context).toContain('05:00 UTC, 27 Oct');
    expect(context).toContain(
      '<https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#alarmsV2:alarm/bike4mind-production-signup-code-send-rate|Open in CloudWatch>'
    );
    expect(message?.text).toBe(
      '🟡 Sign-in code emails above the hourly ceiling: 10 sign-in code emails in the hour ending 05:00 UTC; the ceiling is 10.'
    );
  });

  it('omits the CloudWatch link when Region is absent', () => {
    const message = formatAlarmSlackMessage({ ...sample, Region: undefined }, 'production');
    expect(blocksOf(message)[2].elements?.[0].text).not.toContain('Open in CloudWatch');
  });

  it('explains missing data', () => {
    const alarm = {
      ...sample,
      NewStateReason: 'Insufficient Data: 2 datapoints were missing',
      Trigger: { Period: 300, EvaluationPeriods: 6 },
    };
    expect(describeReason(alarm)).toBe('No data arrived for 30 minutes, which counts as a failure for this alarm.');
    expect(describeReason({ ...alarm, Trigger: undefined })).toBe('No data arrived for a while.');
  });

  it('says floor for less-than alarms and uses a minutes period', () => {
    const alarm = {
      ...sample,
      NewStateReason:
        'Threshold Crossed: 2 datapoints [3.0 (27/10/26 03:55:00), 0.0 (27/10/26 04:00:00)] were less than the threshold (1.0).',
      Trigger: { Period: 300 },
    };
    expect(describeReason(alarm, 'runs')).toBe('0 runs in the 5 minutes ending 04:05 UTC; the floor is 1.');
    expect(describeReason(alarm)).toContain('The value was 0 in the 5 minutes');
  });

  it('rolls the bucket end over midnight', () => {
    const alarm = {
      ...sample,
      NewStateReason: 'Threshold Crossed: 1 datapoint [4.5 (27/10/26 23:00:00)] was greater than the threshold (3.0).',
      Trigger: { Period: 86400 },
    };
    expect(describeReason(alarm, 'errors')).toBe('4.5 errors in the day ending 23:00 UTC; the ceiling is 3.');
  });

  it('reports the newest datapoint whatever order the reason lists them in', () => {
    const alarm = {
      ...sample,
      NewStateReason:
        'Threshold Crossed: 3 out of the last 3 datapoints [97.0 (27/10/26 05:46:00), 96.0 (27/10/26 05:45:00), 98.0 (27/10/26 05:44:00)] were greater than the threshold (95.0).',
      Trigger: { Period: 60 },
    };
    expect(describeReason(alarm, 'errors')).toBe('97 errors in the minute ending 05:47 UTC; the ceiling is 95.');
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
    const section = blocksOf(message)[1].text?.text;
    expect(section).toContain('Something &lt;odd&gt;');
    expect(section).toContain('Errors &lt;5% &amp; latency &gt; 2s');
    expect(blocksOf(message)[2].elements?.[0].text).toContain('|Open in CloudWatch>');
  });

  it('returns the raw reason for anything else', () => {
    expect(describeReason({ ...sample, NewStateReason: 'Something odd' })).toBe('Something odd');
  });

  it('falls back to a suffix title and the alarm description for unknown alarms', () => {
    const message = formatAlarmSlackMessage(
      { ...sample, AlarmName: 'bike4mind-production-brand-new-thing', AlarmDescription: 'A brand new thing broke' },
      'production'
    );
    const blocks = blocksOf(message);
    expect(blocks[0].text?.text).toBe('🟠 Brand new thing');
    expect(blocks[1].text?.text).toContain('*Why it matters*\nA brand new thing broke');
    expect(blocks[1].text?.text).not.toContain('*What to do*');
  });

  it('renders OK as a compact resolved message', () => {
    const message = formatAlarmSlackMessage({ ...sample, NewStateValue: 'OK', OldStateValue: 'ALARM' }, 'production');
    const blocks = blocksOf(message);
    expect(message?.text).toBe('✅ Resolved: Sign-in code emails above the hourly ceiling');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text?.text).toBe(
      '✅ *Resolved: Sign-in code emails above the hourly ceiling*\nproduction · back to normal at 05:00 UTC'
    );
    expect(blocks[1].elements?.[0].text).toContain('Open in CloudWatch');
  });

  it('returns null for INSUFFICIENT_DATA', () => {
    expect(formatAlarmSlackMessage({ ...sample, NewStateValue: 'INSUFFICIENT_DATA' }, 'production')).toBeNull();
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
    expect(blocksOf(message)[0].text?.text).toBe(
      '🟠 The WAF auto-blocker found more abusers than it is allowed to block'
    );
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
  it('posts text and blocks, and throws on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);
    await postAlarmToSlack('https://hooks.slack.example/x', { text: 't', blocks: [{ type: 'divider' }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 't', blocks: [{ type: 'divider' }] });

    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Boom' });
    await expect(postAlarmToSlack('https://hooks.slack.example/x', { text: 't', blocks: [] })).rejects.toThrow(
      'Slack webhook failed: 500 Boom'
    );
  });
});
