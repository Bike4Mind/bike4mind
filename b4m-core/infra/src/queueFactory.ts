/**
 * Pure args builder for the queue + DLQ pair pattern used across product infra.
 *
 * This package never constructs cloud resources (no sst/pulumi dependency); the
 * factory returns plain argument objects that the consuming product feeds into
 * `new sst.aws.Queue(...)`. The DLQ ARN is only known after the DLQ resource is
 * created, so the source-queue args are exposed as a function of that ARN:
 *
 *   const pair = buildQueuePair({ name: 'fooQueue', visibilityTimeout: '6 minutes' });
 *   const fooDLQ = new sst.aws.Queue(pair.dlqName, pair.dlqArgs);
 *   const fooQueue = new sst.aws.Queue(pair.name, pair.queueArgs(fooDLQ.arn));
 */

export type QueueEncryption = 'kms' | 'sse-sqs' | 'none';

/** AWS-managed SQS KMS key alias used for all encrypted queues. */
export const SQS_KMS_KEY_ALIAS = 'alias/aws/sqs';

/** 14 days - the standard DLQ retention window for forensics investigation. */
export const DLQ_FORENSICS_RETENTION_SECONDS = 1209600;

/** Default redrive attempts before a message lands in the DLQ. */
export const DEFAULT_QUEUE_RETRY = 3;

/** Subset of aws.sqs.Queue args the factory sets via SST's transform escape hatch. */
export interface QueueTransformArgs {
  kmsMasterKeyId?: string;
  sqsManagedSseEnabled?: boolean;
  messageRetentionSeconds?: number;
  tags?: Record<string, string>;
}

export interface DlqArgs {
  transform?: { queue: QueueTransformArgs };
}

export interface SourceQueueArgs<TArn> {
  visibilityTimeout: string;
  dlq: { queue: TArn; retry: number };
  transform?: { queue: QueueTransformArgs };
}

export interface BuildQueuePairOptions {
  /** Logical SST resource name of the source queue, e.g. 'imageGenerationQueue'. */
  name: string;
  /** Logical SST resource name for the DLQ. Defaults to `${name}DLQ`. */
  dlqName?: string;
  /**
   * SQS visibility timeout for the source queue, e.g. '11 minutes'. Must exceed
   * the consumer Lambda's timeout (AWS recommends up to 6x for safety margin).
   */
  visibilityTimeout: string;
  /** Redrive attempts before a message lands in the DLQ. Defaults to 3. */
  retry?: number;
  /**
   * Source-queue encryption. 'kms' uses the AWS-managed SQS key; 'sse-sqs' uses
   * SQS-managed SSE (required when cross-account producers send to the queue,
   * since the AWS-managed KMS key policy cannot grant cross-account access).
   * Defaults to 'none'.
   */
  encryption?: QueueEncryption;
  /**
   * DLQ encryption. Defaults to 'kms' whenever the source queue is encrypted
   * (matching every encrypted pair in production infra), otherwise 'none'.
   */
  dlqEncryption?: 'kms' | 'none';
  /**
   * DLQ message retention in seconds. Use DLQ_FORENSICS_RETENTION_SECONDS (14
   * days) for queues whose failures warrant forensic investigation. Omit to
   * keep the SQS default (4 days).
   */
  dlqMessageRetentionSeconds?: number;
  /** Tags applied to both queues via transform. */
  tags?: Record<string, string>;
}

export interface QueuePair<TArn> {
  name: string;
  dlqName: string;
  dlqArgs: DlqArgs;
  queueArgs(dlqArn: TArn): SourceQueueArgs<TArn>;
}

function encryptionTransform(encryption: QueueEncryption): QueueTransformArgs {
  if (encryption === 'kms') return { kmsMasterKeyId: SQS_KMS_KEY_ALIAS };
  if (encryption === 'sse-sqs') return { sqsManagedSseEnabled: true };
  return {};
}

/** Wraps non-empty transform args in SST's `{ transform: { queue } }` shape. */
function toTransform(args: QueueTransformArgs): { transform: { queue: QueueTransformArgs } } | undefined {
  return Object.keys(args).length > 0 ? { transform: { queue: args } } : undefined;
}

export function buildQueuePair<TArn = string>(options: BuildQueuePairOptions): QueuePair<TArn> {
  const {
    name,
    dlqName = `${options.name}DLQ`,
    visibilityTimeout,
    retry = DEFAULT_QUEUE_RETRY,
    encryption = 'none',
    dlqEncryption = encryption === 'none' ? 'none' : 'kms',
    dlqMessageRetentionSeconds,
    tags,
  } = options;

  if (!name) throw new Error('buildQueuePair: name is required');
  if (dlqName === name) throw new Error(`buildQueuePair: dlqName must differ from name "${name}"`);
  if (!visibilityTimeout) throw new Error(`buildQueuePair: visibilityTimeout is required for "${name}"`);
  if (!Number.isInteger(retry) || retry < 0) {
    throw new Error(`buildQueuePair: retry must be a non-negative integer for "${name}", got ${retry}`);
  }

  const dlqTransform: QueueTransformArgs = {
    ...encryptionTransform(dlqEncryption),
    ...(dlqMessageRetentionSeconds !== undefined ? { messageRetentionSeconds: dlqMessageRetentionSeconds } : {}),
    ...(tags ? { tags } : {}),
  };
  const queueTransform: QueueTransformArgs = {
    ...encryptionTransform(encryption),
    ...(tags ? { tags } : {}),
  };

  return {
    name,
    dlqName,
    dlqArgs: { ...toTransform(dlqTransform) },
    queueArgs: (dlqArn: TArn) => ({
      visibilityTimeout,
      dlq: { queue: dlqArn, retry },
      ...toTransform(queueTransform),
    }),
  };
}
