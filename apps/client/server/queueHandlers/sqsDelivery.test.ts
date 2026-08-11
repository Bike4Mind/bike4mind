import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SQSEvent } from 'aws-lambda';
import {
  getDeliveryAttempt,
  isFinalDeliveryAttempt,
  FAB_FILE_CHUNK_MAX_RECEIVE_COUNT,
  FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT,
} from './sqsDelivery';

// infra/queues.ts constructs real SST cloud resources at import time (no plain data export), so
// it can't be imported here - read its source text instead. This is what actually catches drift:
// a future dlq.retry bump on either queue changes what this reads and fails the test, rather than
// two hardcoded numbers rubber-stamping themselves forever.
function retryFromInfra(queueVarName: string): number {
  const src = readFileSync(join(__dirname, '../../../../infra/queues.ts'), 'utf8');
  const match = src.match(
    new RegExp(`const ${queueVarName}\\s*=\\s*new sst\\.aws\\.Queue\\([^)]*?dlq:\\s*\\{[^}]*?retry:\\s*(\\d+)`)
  );
  if (!match) throw new Error(`Could not find a dlq.retry value for ${queueVarName} in infra/queues.ts`);
  return Number(match[1]);
}

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
  it('matches infra/queues.ts dlq.retry for fabFileChunkQueue', () => {
    expect(FAB_FILE_CHUNK_MAX_RECEIVE_COUNT).toBe(retryFromInfra('fabFileChunkQueue'));
  });

  it('matches infra/queues.ts dlq.retry for fabFileVectorizeQueue', () => {
    expect(FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT).toBe(retryFromInfra('fabFileVectorizeQueue'));
  });
});
