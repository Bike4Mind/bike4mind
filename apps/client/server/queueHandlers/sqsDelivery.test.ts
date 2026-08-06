import { describe, it, expect } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import {
  getDeliveryAttempt,
  isFinalDeliveryAttempt,
  FAB_FILE_CHUNK_MAX_RECEIVE_COUNT,
  FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT,
} from './sqsDelivery';

function eventWithReceiveCount(value: string | undefined): SQSEvent {
  return {
    Records: [
      {
        attributes: value === undefined ? {} : { ApproximateReceiveCount: value },
      },
    ],
  } as unknown as SQSEvent;
}

describe('getDeliveryAttempt', () => {
  it.each([
    ['1', 1],
    ['2', 2],
    ['10', 10],
  ])('parses a positive integer string %s as %d', (raw, expected) => {
    expect(getDeliveryAttempt(eventWithReceiveCount(raw))).toBe(expected);
  });

  it.each([undefined, '', 'abc', '0', '-1', '1.5'])('returns undefined for malformed/absent value %s', raw => {
    expect(getDeliveryAttempt(eventWithReceiveCount(raw))).toBeUndefined();
  });

  it('returns undefined when Records is empty', () => {
    expect(getDeliveryAttempt({ Records: [] } as unknown as SQSEvent)).toBeUndefined();
  });

  it('returns undefined when attributes is absent entirely', () => {
    expect(getDeliveryAttempt({ Records: [{}] } as unknown as SQSEvent)).toBeUndefined();
  });
});

describe('isFinalDeliveryAttempt', () => {
  it.each([
    ['1', false],
    ['2', false],
    ['3', true],
    ['4', true],
  ])('attempt %s vs max 3 -> final=%s', (raw, expected) => {
    expect(isFinalDeliveryAttempt(eventWithReceiveCount(raw), 3)).toBe(expected);
  });

  it.each([undefined, '', 'abc', '0', '-1', '1.5'])(
    'treats a malformed/absent receive count (%s) as final - fails toward terminal, not a hang',
    raw => {
      expect(isFinalDeliveryAttempt(eventWithReceiveCount(raw), 3)).toBe(true);
    }
  );
});

describe('per-queue max-receive constants', () => {
  it('are both 3, matching infra/queues.ts dlq.retry for these two queues', () => {
    expect(FAB_FILE_CHUNK_MAX_RECEIVE_COUNT).toBe(3);
    expect(FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT).toBe(3);
  });
});
