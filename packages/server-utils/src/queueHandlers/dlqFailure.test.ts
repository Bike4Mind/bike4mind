import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn(), record: vi.fn() }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = h.send;
  },
  GetQueueAttributesCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@bike4mind/database', () => ({ dlqFailureRepository: { record: h.record } }));

import { failureCategory, recordFinalDlqFailures } from './dlqFailure';

const fixtureArn = ['arn', 'aws', 'sqs', 'us-east-2', '000000000000', 'fixture-queue'].join(':');
const event = (receiveCount: string, id = 'message-1') =>
  ({
    Records: [
      {
        messageId: id,
        body: '{"userContent":"do not persist"}',
        eventSourceARN: fixtureArn,
        attributes: { ApproximateReceiveCount: receiveCount },
      },
    ],
  }) as never;

describe('final DLQ failure recording', () => {
  beforeEach(() => {
    h.send.mockReset().mockResolvedValue({ Attributes: { RedrivePolicy: JSON.stringify({ maxReceiveCount: 3 }) } });
    h.record.mockReset().mockResolvedValue(undefined);
  });

  it('reads the actual source queue redrive policy and records only the final attempt', async () => {
    await recordFinalDlqFailures(event('2'), new Error('transient'));
    expect(h.record).not.toHaveBeenCalled();
    expect(h.send.mock.calls[0][0].input).toEqual({
      QueueUrl: 'https://sqs.us-east-2.amazonaws.com/000000000000/fixture-queue',
      AttributeNames: ['RedrivePolicy'],
    });
    await recordFinalDlqFailures(event('3'), new Error('request timed out'));
    expect(h.record).toHaveBeenCalledOnce();
    expect(h.record.mock.calls[0][0]).toMatchObject({
      queueLabel: 'fixture-queue',
      messageId: 'message-1',
      errorType: 'Error',
      errorMessage: 'request timed out',
      category: 'timeout',
      consumerVersion: expect.any(String),
      failedAt: expect.any(Date),
    });
    expect(JSON.stringify(h.record.mock.calls)).not.toContain('userContent');
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('does not write without a valid redrive policy or receive count', async () => {
    await recordFinalDlqFailures(event('invalid'), new Error('broken'));
    expect(h.record).not.toHaveBeenCalled();
  });

  it('does not record earlier deliveries in a mixed batch', async () => {
    const mixed = event('3') as {
      Records: Array<{ attributes: { ApproximateReceiveCount: string }; messageId: string }>;
    };
    mixed.Records.push({ ...mixed.Records[0], messageId: 'early', attributes: { ApproximateReceiveCount: '2' } });
    await recordFinalDlqFailures(mixed as never, new Error('failed'));
    expect(h.record).toHaveBeenCalledOnce();
    expect(h.record.mock.calls[0][0].messageId).toBe('message-1');
  });

  it.each([
    ['AccessDenied', 'request refused', 'refused'],
    ['SyntaxError', 'invalid output', 'invalid output'],
    ['Error', 'unexpected failure', 'bug'],
    ['Other', 'unclassified', 'unknown'],
  ])('categorizes %s as %s', (type, message, category) => {
    expect(failureCategory(type, message)).toBe(category);
  });
});
