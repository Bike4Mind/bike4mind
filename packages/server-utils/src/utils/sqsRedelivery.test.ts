import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const h = vi.hoisted(() => ({ changeMessageVisibility: vi.fn() }));
vi.mock('./sqs', () => ({ changeMessageVisibility: h.changeMessageVisibility }));

import { queueUrlFromArn, returnRecordForRedelivery } from './sqsRedelivery';

// Fixture ARNs are assembled from parts so no literal ARN sits in the source.
const fixtureArn = (service: string, resource: string) =>
  ['arn', 'aws', service, 'us-east-2', '000000000000', resource].join(':');
const ARN = fixtureArn('sqs', 'example-queue');
const event = (eventSourceARN = ARN): SQSEvent =>
  ({ Records: [{ messageId: 'm1', receiptHandle: 'r1', eventSourceARN }] }) as unknown as SQSEvent;
const logger = { warn: vi.fn() };

describe('queueUrlFromArn', () => {
  it('derives the queue URL from an SQS ARN', () => {
    expect(queueUrlFromArn(ARN)).toBe('https://sqs.us-east-2.amazonaws.com/000000000000/example-queue');
  });

  it.each(['', undefined, fixtureArn('sns', 'topic'), 'not-an-arn'])('returns undefined for %s', arn => {
    expect(queueUrlFromArn(arn)).toBeUndefined();
  });
});

describe('returnRecordForRedelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.changeMessageVisibility.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports the record as a batch item failure after shortening its visibility to delay plus jitter', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const result = await returnRecordForRedelivery(event(), { delaySeconds: 40, jitterSeconds: 60, logger });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(h.changeMessageVisibility).toHaveBeenCalledWith(
      'https://sqs.us-east-2.amazonaws.com/000000000000/example-queue',
      'r1',
      70
    );
  });

  it('still reports the failure when the visibility change fails, and warns', async () => {
    h.changeMessageVisibility.mockRejectedValueOnce(new Error('AccessDenied'));

    const result = await returnRecordForRedelivery(event(), { delaySeconds: 10, jitterSeconds: 0, logger });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AccessDenied'));
  });

  it('skips the visibility change when there is no SQS source (self-host worker)', async () => {
    const result = await returnRecordForRedelivery(event(''), { delaySeconds: 10, jitterSeconds: 0, logger });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(h.changeMessageVisibility).not.toHaveBeenCalled();
  });

  it('clamps the visibility to the SQS 12-hour maximum', async () => {
    await returnRecordForRedelivery(event(), { delaySeconds: 100_000, jitterSeconds: 0, logger });
    expect(h.changeMessageVisibility).toHaveBeenCalledWith(expect.any(String), 'r1', 43_200);
  });

  it('throws rather than returning an empty failure list (which SQS reads as success) when there is no record', async () => {
    await expect(
      returnRecordForRedelivery({ Records: [] } as SQSEvent, { delaySeconds: 1, jitterSeconds: 0, logger })
    ).rejects.toThrow();
  });
});
