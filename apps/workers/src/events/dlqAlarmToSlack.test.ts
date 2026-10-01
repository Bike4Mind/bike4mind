import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SNSEvent } from 'aws-lambda';
import { handler } from './dlqAlarmToSlack';

vi.mock('sst', () => ({
  Resource: {
    SLACK_ERROR_REPORTING_WEBHOOK_URL: { value: 'https://hooks.slack.example/webhook' },
    App: { stage: 'dev' },
  },
}));

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

const alarmPayload = (state: string) =>
  JSON.stringify({
    AlarmName: 'test-alarm',
    AlarmDescription: 'Test alarm description',
    NewStateValue: state,
    NewStateReason: 'Threshold crossed',
    StateChangeTime: '2026-01-01T00:00:00.000Z',
  });

describe('dlqAlarmToSlack handler', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('posts to Slack when alarm transitions to ALARM state', async () => {
    await handler(makeEvent(alarmPayload('ALARM')));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.example/webhook');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain('test-alarm');
    expect(body.text).toContain('Test alarm description');
  });

  it('suppresses OK (resolved) transitions to reduce channel noise', async () => {
    await handler(makeEvent(alarmPayload('OK')));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('suppresses INSUFFICIENT_DATA transitions', async () => {
    await handler(makeEvent(alarmPayload('INSUFFICIENT_DATA')));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips records with non-JSON SNS message payloads', async () => {
    await handler(makeEvent('not-json'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the Slack webhook returns a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    await expect(handler(makeEvent(alarmPayload('ALARM')))).rejects.toThrow('Slack webhook failed: 500');
  });
});
