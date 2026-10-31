import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SNSEvent } from 'aws-lambda';

const resource = vi.hoisted(() => ({
  SLACK_ERROR_REPORTING_WEBHOOK_URL: { value: 'https://hooks.slack.example/webhook' },
  SLACK_ALARMS_WEBHOOK_URL: undefined as { value: string } | undefined,
  App: { stage: 'production' },
}));

vi.mock('sst', () => ({ Resource: resource }));

const detail = vi.hoisted(() => ({
  youngAccountSpendSection: vi.fn(async () => '*Top accounts in the window*\n1. `u1` 1.52 USD in 36 calls'),
}));
vi.mock('./youngAccountSpendDetail', () => detail);

import { handler } from './dlqAlarmToSlack';

const makeEvent = (message: string): SNSEvent => ({
  Records: [
    {
      EventSource: 'aws:sns',
      EventVersion: '1.0',
      EventSubscriptionArn: 'arn:aws:sns:us-east-1:123456789012:test:abc',
      Sns: {
        Type: 'Notification',
        MessageId: 'msg-id',
        TopicArn: 'arn:aws:sns:us-east-1:123456789012:test',
        Subject: null as unknown as string,
        Message: message,
        Timestamp: '2026-01-01T00:00:00.000Z',
        SignatureVersion: '1',
        Signature: 'sig',
        SigningCertUrl: 'https://sns.example.com/cert.pem',
        UnsubscribeUrl: 'https://sns.example.com/unsubscribe',
        MessageAttributes: {},
      },
    },
  ],
});

const alarmPayload = (state: string, alarmName = 'bike4mind-production-test-alarm') =>
  JSON.stringify({
    AlarmName: alarmName,
    AlarmDescription: 'Test alarm description',
    NewStateValue: state,
    NewStateReason: 'Threshold crossed',
    StateChangeTime: '2026-01-01T00:00:00.000Z',
  });

const YOUNG_ACCOUNT_ALARM = 'bike4mind-production-young-account-spend-rate';

describe('dlqAlarmToSlack handler', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resource.SLACK_ALARMS_WEBHOOK_URL = undefined;
    resource.App.stage = 'production';
    detail.youngAccountSpendSection.mockClear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('lists the top accounts on a young-account spend alarm', async () => {
    await handler(makeEvent(alarmPayload('ALARM', YOUNG_ACCOUNT_ALARM)));
    expect(detail.youngAccountSpendSection).toHaveBeenCalledOnce();
    expect(detail.youngAccountSpendSection.mock.calls[0][0]).toMatchObject({ AlarmName: YOUNG_ACCOUNT_ALARM });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const sections = (body.attachments[0].blocks as { type: string; text?: { text: string } }[])
      .filter(b => b.type === 'section' && b.text)
      .map(b => b.text!.text.split('\n')[0]);
    expect(sections).toEqual(['*What happened*', '*Why it matters*', '*Top accounts in the window*', '*What to do*']);
    expect(JSON.stringify(body.attachments)).toContain('`u1` 1.52 USD in 36 calls');
  });

  it('does not look accounts up for other alarms, resolutions, or alarms this stage drops', async () => {
    await handler(makeEvent(alarmPayload('ALARM')));
    await handler(makeEvent(alarmPayload('OK', YOUNG_ACCOUNT_ALARM)));
    resource.App.stage = 'dev';
    await handler(makeEvent(alarmPayload('ALARM', 'bike4mind-dev-test-alarm')));
    expect(detail.youngAccountSpendSection).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('posts an explained message when alarm transitions to ALARM state', async () => {
    await handler(makeEvent(alarmPayload('ALARM')));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.example/webhook');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain('Test alarm');
    expect(JSON.stringify(body.blocks)).toContain(':warning: Production warning: Test alarm');
    expect(JSON.stringify(body.attachments)).toContain('Test alarm description');
    expect(JSON.stringify(body.attachments)).toContain('bike4mind-production-test-alarm');
  });

  it('posts a resolved message when the alarm returns to OK', async () => {
    await handler(makeEvent(alarmPayload('OK')));
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toBe(':white_check_mark: Resolved: Test alarm');
    expect(body.blocks).toBeUndefined();
    expect(body.attachments[0].color).toBe('#2EB67D');
  });

  it('posts to the alarms channel when SLACK_ALARMS_WEBHOOK_URL is set', async () => {
    resource.SLACK_ALARMS_WEBHOOK_URL = { value: 'https://hooks.slack.example/alarms' };
    await handler(makeEvent(alarmPayload('ALARM')));
    expect(fetchMock.mock.calls[0][0]).toBe('https://hooks.slack.example/alarms');
  });

  it('suppresses INSUFFICIENT_DATA transitions', async () => {
    await handler(makeEvent(alarmPayload('INSUFFICIENT_DATA')));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips records with non-JSON SNS message payloads', async () => {
    await handler(makeEvent('not-json'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips JSON payloads that are not alarms', async () => {
    await handler(makeEvent(JSON.stringify({ hello: 'world' })));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the Slack webhook returns a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    await expect(handler(makeEvent(alarmPayload('ALARM')))).rejects.toThrow('Slack webhook failed: 500');
  });
});
