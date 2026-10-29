import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SNSEvent } from 'aws-lambda';

const resource = vi.hoisted(() => ({
  SLACK_ERROR_REPORTING_WEBHOOK_URL: { value: 'https://hooks.slack.example/webhook' },
  SLACK_ALARMS_WEBHOOK_URL: undefined as { value: string } | undefined,
  App: { stage: 'production' },
}));

vi.mock('sst', () => ({ Resource: resource }));

import { handler } from './wafAlarmToSlack';

const makeEvent = (message: string): SNSEvent => ({ Records: [{ Sns: { Message: message } }] }) as unknown as SNSEvent;

const alarm = (state: string) =>
  JSON.stringify({
    AlarmName: 'waf-runtime-blocker-prod-no-successful-run',
    NewStateValue: state,
    OldStateValue: 'OK',
    NewStateReason: 'Insufficient Data: 6 datapoints were missing',
    StateChangeTime: '2026-10-27T05:00:58.488+0000',
    Trigger: { Period: 300, EvaluationPeriods: 6 },
  });

describe('wafAlarmToSlack handler', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resource.SLACK_ALARMS_WEBHOOK_URL = undefined;
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('posts an explained ALARM message to the error-reporting url by default', async () => {
    await handler(makeEvent(alarm('ALARM')));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.example/webhook');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain('The WAF auto-blocker has stopped running');
    expect(body.text).toContain('No data arrived for 30 minutes');
  });

  it('posts to the alarms channel when SLACK_ALARMS_WEBHOOK_URL is set', async () => {
    resource.SLACK_ALARMS_WEBHOOK_URL = { value: 'https://hooks.slack.example/alarms' };
    await handler(makeEvent(alarm('ALARM')));
    expect(fetchMock.mock.calls[0][0]).toBe('https://hooks.slack.example/alarms');
  });

  it('posts a resolved message for OK', async () => {
    await handler(makeEvent(alarm('OK')));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toBe(':white_check_mark: Resolved: The WAF auto-blocker has stopped running');
  });

  it('skips INSUFFICIENT_DATA, non-JSON and non-alarm payloads', async () => {
    await handler(makeEvent(alarm('INSUFFICIENT_DATA')));
    await handler(makeEvent('not-json'));
    await handler(makeEvent(JSON.stringify({ hello: 'world' })));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the webhook fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
    await expect(handler(makeEvent(alarm('ALARM')))).rejects.toThrow('Slack webhook failed: 500');
  });
});
