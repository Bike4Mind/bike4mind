import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SNSEvent } from 'aws-lambda';
import { handler } from './serviceHealthAlarmToSlack';

vi.mock('sst', () => ({
  Resource: {
    SLACK_ERROR_REPORTING_WEBHOOK_URL: { value: 'https://hooks.slack.example/webhook' },
    App: { stage: 'production' },
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeEvent(...payloads: unknown[]): SNSEvent {
  return {
    Records: payloads.map(p => ({ Sns: { Message: JSON.stringify(p) } })),
  } as unknown as SNSEvent;
}

function postedText(callIndex = 0): string {
  const [, init] = mockFetch.mock.calls[callIndex];
  return JSON.parse(init.body as string).text;
}

const noTasksAlarm = {
  AlarmName: 'bike4mind-production-ecs-subscriber-fanout-no-tasks',
  AlarmDescription: 'Subscriber Fanout has no running ECS tasks - the service is down.',
  OldStateValue: 'OK',
  NewStateValue: 'ALARM',
  NewStateReason: 'Insufficient Data: 2 datapoints were missing',
  StateChangeTime: '2026-07-31T17:15:00.000Z',
  Region: 'US East (Ohio)',
};

// Shaped after the real event that fired every ~13 minutes while the fanout was down.
const taskFailedToStart = {
  'detail-type': 'ECS Task State Change',
  source: 'aws.ecs',
  detail: {
    group: 'service:subscriberFanoutV2',
    stopCode: 'TaskFailedToStart',
    stoppedReason: 'Task failed to start',
    taskArn: 'arn:aws:ecs:us-east-2:1234:task/cluster/abc123',
    containers: [
      {
        name: 'subscriberFanoutV2',
        reason: 'CannotPullContainerError: pull image manifest ... 403 Forbidden',
      },
    ],
  },
};

describe('serviceHealthAlarmToSlack handler', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  });

  it('reports a no-tasks alarm with the service name and stage', async () => {
    await handler(makeEvent(noTasksAlarm));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://hooks.slack.example/webhook');
    expect(init.method).toBe('POST');
    const text = postedText();
    expect(text).toContain('bike4mind-production-ecs-subscriber-fanout-no-tasks');
    expect(text).toContain('Stage: production');
  });

  it('suppresses OK and INSUFFICIENT_DATA transitions', async () => {
    await handler(makeEvent({ ...noTasksAlarm, NewStateValue: 'OK' }));
    await handler(makeEvent({ ...noTasksAlarm, NewStateValue: 'INSUFFICIENT_DATA' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // The container-level reason is the diagnostic payload; the task-level
  // stoppedReason is a generic wrapper that would have said nothing useful.
  it('surfaces the container reason for a task that failed to start', async () => {
    await handler(makeEvent(taskFailedToStart));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const text = postedText();
    expect(text).toContain('service:subscriberFanoutV2');
    expect(text).toContain('Failed To Start');
    expect(text).toContain('CannotPullContainerError');
    expect(text).not.toContain('Task failed to start');
  });

  it('falls back to stoppedReason when no container reported one', async () => {
    const noContainerReason = {
      ...taskFailedToStart,
      detail: { ...taskFailedToStart.detail, containers: [{ name: 'x' }] },
    };
    await handler(makeEvent(noContainerReason));
    expect(postedText()).toContain('Task failed to start');
  });

  // The EventBridge rule already filters to TaskFailedToStart, so these two can only arrive if
  // someone broadens it. Dropping them keeps the "Failed To Start" heading true by construction,
  // and keeps a routine deploy (which stops tasks under UserInitiated / ServiceSchedulerInitiated)
  // from burying the alarms that matter under deploy noise.
  it('drops a stopped task that did not fail to start', async () => {
    const essentialExited = {
      ...taskFailedToStart,
      detail: { ...taskFailedToStart.detail, stopCode: 'EssentialContainerExited' },
    };
    await handler(makeEvent(essentialExited));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('drops a task event carrying no stop code', async () => {
    await handler(makeEvent({ 'detail-type': 'ECS Task State Change' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ignores payloads that are neither an alarm nor a task state change', async () => {
    await handler(makeEvent({ hello: 'world' }, 'not json at all'));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports every actionable record in a batched delivery', async () => {
    await handler(makeEvent(noTasksAlarm, { ...noTasksAlarm, NewStateValue: 'OK' }, taskFailedToStart));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(postedText(0)).toContain('no-tasks');
    expect(postedText(1)).toContain('Failed To Start');
  });

  it('throws when Slack rejects the post so the subscription redrives', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
    await expect(handler(makeEvent(noTasksAlarm))).rejects.toThrow(/Slack webhook failed: 500/);
  });
});
