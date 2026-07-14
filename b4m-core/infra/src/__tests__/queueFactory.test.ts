import { describe, it, expect } from 'vitest';
import {
  buildQueuePair,
  SQS_KMS_KEY_ALIAS,
  DLQ_FORENSICS_RETENTION_SECONDS,
  DEFAULT_QUEUE_RETRY,
} from '../queueFactory.js';

describe('buildQueuePair', () => {
  it('builds the minimal unencrypted pair with defaults', () => {
    const pair = buildQueuePair({ name: 'fooQueue', visibilityTimeout: '6 minutes' });
    expect(pair.name).toBe('fooQueue');
    expect(pair.dlqName).toBe('fooQueueDLQ');
    expect(pair.dlqArgs).toEqual({});
    expect(pair.queueArgs('arn:dlq')).toEqual({
      visibilityTimeout: '6 minutes',
      dlq: { queue: 'arn:dlq', retry: DEFAULT_QUEUE_RETRY },
    });
  });

  it('respects an explicit dlqName and retry count', () => {
    const pair = buildQueuePair({
      name: 'videoGenerationQueue',
      dlqName: 'videoGenerationDLQ',
      visibilityTimeout: '20 minutes',
      retry: 2,
    });
    expect(pair.dlqName).toBe('videoGenerationDLQ');
    expect(pair.queueArgs('arn').dlq).toEqual({ queue: 'arn', retry: 2 });
  });

  it('kms encryption sets the AWS-managed key on both queues', () => {
    const pair = buildQueuePair({ name: 'q', visibilityTimeout: '5 minutes', encryption: 'kms' });
    expect(pair.dlqArgs).toEqual({ transform: { queue: { kmsMasterKeyId: SQS_KMS_KEY_ALIAS } } });
    expect(pair.queueArgs('arn').transform).toEqual({ queue: { kmsMasterKeyId: SQS_KMS_KEY_ALIAS } });
  });

  it('sse-sqs on the source queue defaults the DLQ to kms (cross-account producer pattern)', () => {
    const pair = buildQueuePair({ name: 'q', visibilityTimeout: '3 minutes', encryption: 'sse-sqs' });
    expect(pair.queueArgs('arn').transform).toEqual({ queue: { sqsManagedSseEnabled: true } });
    expect(pair.dlqArgs).toEqual({ transform: { queue: { kmsMasterKeyId: SQS_KMS_KEY_ALIAS } } });
  });

  it('dlqEncryption none can opt the DLQ out even when the source is encrypted', () => {
    const pair = buildQueuePair({
      name: 'q',
      visibilityTimeout: '3 minutes',
      encryption: 'kms',
      dlqEncryption: 'none',
    });
    expect(pair.dlqArgs).toEqual({});
  });

  it('applies forensic DLQ retention when requested', () => {
    const pair = buildQueuePair({
      name: 'q',
      visibilityTimeout: '5 minutes',
      encryption: 'kms',
      dlqMessageRetentionSeconds: DLQ_FORENSICS_RETENTION_SECONDS,
    });
    expect(pair.dlqArgs).toEqual({
      transform: {
        queue: { kmsMasterKeyId: SQS_KMS_KEY_ALIAS, messageRetentionSeconds: 1209600 },
      },
    });
    // Retention applies to the DLQ only, never the source queue.
    expect(pair.queueArgs('arn').transform).toEqual({ queue: { kmsMasterKeyId: SQS_KMS_KEY_ALIAS } });
  });

  it('applies tags to both queues via transform', () => {
    const tags = { Application: 'ImageGeneration' };
    const pair = buildQueuePair({ name: 'q', visibilityTimeout: '5 minutes', tags });
    expect(pair.dlqArgs).toEqual({ transform: { queue: { tags } } });
    expect(pair.queueArgs('arn').transform).toEqual({ queue: { tags } });
  });

  it('is generic over the ARN type (Pulumi Output passthrough)', () => {
    const fakeOutput = { __pulumiOutput: true };
    const pair = buildQueuePair<typeof fakeOutput>({ name: 'q', visibilityTimeout: '1 minute' });
    expect(pair.queueArgs(fakeOutput).dlq.queue).toBe(fakeOutput);
  });

  it('rejects invalid input', () => {
    expect(() => buildQueuePair({ name: '', visibilityTimeout: '1 minute' })).toThrow('name is required');
    expect(() => buildQueuePair({ name: 'q', dlqName: 'q', visibilityTimeout: '1 minute' })).toThrow(
      'dlqName must differ'
    );
    expect(() => buildQueuePair({ name: 'q', visibilityTimeout: '' })).toThrow('visibilityTimeout is required');
    expect(() => buildQueuePair({ name: 'q', visibilityTimeout: '1 minute', retry: -1 })).toThrow(
      'retry must be a non-negative integer'
    );
    expect(() => buildQueuePair({ name: 'q', visibilityTimeout: '1 minute', retry: 1.5 })).toThrow(
      'retry must be a non-negative integer'
    );
  });
});
