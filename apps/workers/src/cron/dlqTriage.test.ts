import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ send: vi.fn(), collect: vi.fn(), notify: vi.fn(), finish: vi.fn(), post: vi.fn() }));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = h.send;
  },
  DescribeAlarmsCommand: class {},
}));
vi.mock('sst', () => ({ Resource: { App: { name: 'app', stage: 'test' } } }));
vi.mock('../events/dlqTriage', () => ({
  collectDlqTriage: h.collect,
  canNotifyDlqTriage: h.notify,
  finishDlqTriageDelivery: h.finish,
}));
vi.mock('../events/alarmSlackMessage', () => ({
  appUrlFromEnv: () => 'https://example.test',
  resolveAlarmWebhookUrl: () => 'fixture',
  postAlarmToSlack: h.post,
}));
import { handler } from './dlqTriage';

beforeEach(() => {
  vi.resetAllMocks();
  h.send.mockResolvedValue({
    MetricAlarms: [
      { AlarmName: 'app-test-dlq-one-messages' },
      { AlarmName: 'app-test-dlq-one-age' },
      { AlarmName: 'app-test-dlq-two-messages' },
    ],
  });
  h.notify.mockResolvedValue(true);
  h.post.mockResolvedValue({ state: 'unconfirmed' });
});
describe('DLQ triage daily sweep', () => {
  it('continues after a queue fails, deduplicates age/count alarms and reports the failed run', async () => {
    h.collect.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ section: 'sampled' });
    await expect(handler()).rejects.toThrow('failed for 1 queues');
    expect(h.collect).toHaveBeenCalledTimes(2);
    expect(h.post).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledWith({ section: 'sampled' }, false);
  });
  it('does not notify after the switch is turned off', async () => {
    h.collect.mockResolvedValue({ section: 'sampled' });
    h.notify.mockResolvedValue(false);
    await handler();
    expect(h.post).not.toHaveBeenCalled();
  });
});
