import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SNSEvent } from 'aws-lambda';
import { handler } from './alarmToSlack';

vi.mock('sst', () => ({
  Resource: {
    SLACK_ERROR_REPORTING_WEBHOOK_URL: { value: 'https://hooks.slack.example/webhook' },
    App: { stage: 'dev' },
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Build a minimal SNSEvent wrapping a CloudWatch alarm payload. */
function makeEvent(payload: Record<string, unknown>): SNSEvent {
  return {
    Records: [
      {
        Sns: { Message: JSON.stringify(payload) },
      },
    ],
  } as unknown as SNSEvent;
}

const baseAlarm = {
  AlarmName: 'lumina5-dev-overwatch-connection-revoke-failure',
  AlarmDescription: 'LinkedIn token revocation failing at sustained rate',
  OldStateValue: 'OK',
  NewStateReason: 'Threshold Crossed',
  StateChangeTime: '2026-06-27T00:00:00.000Z',
  Region: 'US East (N. Virginia)',
};

describe('alarmToSlack handler', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  });

  it('posts to Slack on ALARM state transition', async () => {
    await handler(makeEvent({ ...baseAlarm, NewStateValue: 'ALARM' }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://hooks.slack.example/webhook');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain(baseAlarm.AlarmName);
  });

  it('suppresses OK (resolved) transitions', async () => {
    await handler(makeEvent({ ...baseAlarm, NewStateValue: 'OK' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('suppresses INSUFFICIENT_DATA transitions', async () => {
    await handler(makeEvent({ ...baseAlarm, NewStateValue: 'INSUFFICIENT_DATA' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
