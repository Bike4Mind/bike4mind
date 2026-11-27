/**
 * KMS key that wraps the per-stage data key for secrets stored at rest. Production and staging
 * (`dev`) own a dedicated key; preview stages share one key owned outside any stage and passed by
 * ARN (same ownership pattern as the shared preview certificate); other stages have no key.
 *
 * The key policy, event patterns and IAM grant are pure builders so they can be unit tested.
 * Imports only constants so sst.config.ts can load it before ./infra without a cycle. The alarms and
 * the probe live in infra/secretsAtRestKeyAccess.ts.
 *
 * The preview key's owner should carry secretsAtRestPreviewKeyPolicy (the same policy, pinned to any
 * stage matching `pr*` rather than one, plus a Decrypt deny binding the context stage to the caller's stage
 * tag) and the same alarms. Changing it means the owner re-applies the shared key's policy.
 */

import { isPreviewStage, runsScheduledJobs } from './constants';

export const SECRETS_AT_REST_PURPOSE = 'secrets-at-rest';

/** Must match the KMS encryption context packages/scripts/src/createWrappedStageDataKey.ts mints with. */
export const secretsAtRestEncryptionContext = (stage: string) => ({ purpose: SECRETS_AT_REST_PURPOSE, stage });

export type SecretsAtRestKeyKind = 'dedicated' | 'shared' | 'none';

export function secretsAtRestKeyKind(input: {
  runsScheduledJobs: boolean;
  isPreviewStage: boolean;
  previewKeyArn: string | undefined;
}): SecretsAtRestKeyKind {
  if (input.runsScheduledJobs) return 'dedicated';
  if (input.isPreviewStage && input.previewKeyArn) return 'shared';
  return 'none';
}

const POLICY_VERSION = '2012-10-17';

/**
 * Tag put on every IAM role this stack creates, naming the stage it belongs to. Key policies do not
 * evaluate lambda:SourceFunctionArn, so "this stage's app" is expressed as a principal tag instead.
 */
export const SECRETS_AT_REST_ROLE_TAG = 'b4m:secrets-at-rest-stage';

export function secretsAtRestRoleTags(tags: Record<string, string> | undefined, stage: string) {
  return { ...tags, [SECRETS_AT_REST_ROLE_TAG]: stage };
}

/** Stage glob a shared preview key serves: every stage whose name starts with `pr` (a superset of `pr<N>`). */
const PREVIEW_STAGE_PATTERN = 'pr*';

function buildKeyPolicy(
  input: { partition: string; accountId: string },
  stageIs: { operator: 'StringNotEquals' | 'StringNotLike'; value: string }
) {
  const contextActions = ['kms:Decrypt', 'kms:GenerateDataKeyWithoutPlaintext'];
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Sid: 'EnableAccountAdministration',
        Effect: 'Allow',
        Principal: { AWS: `arn:${input.partition}:iam::${input.accountId}:root` },
        Action: 'kms:*',
        Resource: '*',
      },
      {
        Sid: 'DenyWithoutPurposeContext',
        Effect: 'Deny',
        Principal: '*',
        Action: contextActions,
        Resource: '*',
        Condition: { StringNotEquals: { 'kms:EncryptionContext:purpose': SECRETS_AT_REST_PURPOSE } },
      },
      {
        Sid: 'DenyWithoutStageContext',
        Effect: 'Deny',
        Principal: '*',
        Action: contextActions,
        Resource: '*',
        Condition: { [stageIs.operator]: { 'kms:EncryptionContext:stage': stageIs.value } },
      },
      {
        // The only blob is minted by GenerateDataKeyWithoutPlaintext. These two return or accept a key
        // the caller chose, which would let an operator plant a data key whose plaintext they know.
        Sid: 'DenyChosenOrPlaintextDataKey',
        Effect: 'Deny',
        Principal: '*',
        Action: ['kms:GenerateDataKey', 'kms:Encrypt'],
        Resource: '*',
        Condition: { StringEquals: { 'kms:EncryptionContext:purpose': SECRETS_AT_REST_PURPOSE } },
      },
      {
        // No caller re-wraps the blob; the grant is Decrypt only.
        Sid: 'DenyReEncrypt',
        Effect: 'Deny',
        Principal: '*',
        Action: ['kms:ReEncrypt*'],
        Resource: '*',
      },
      {
        // Operators mint the wrapped blob but can never unwrap one; only this stage's roles can.
        Sid: 'DenyDecryptOutsideApp',
        Effect: 'Deny',
        Principal: '*',
        Action: ['kms:Decrypt'],
        Resource: '*',
        Condition: { [stageIs.operator]: { [`aws:PrincipalTag/${SECRETS_AT_REST_ROLE_TAG}`]: stageIs.value } },
      },
    ],
  };
}

export function secretsAtRestKeyPolicy(input: { partition: string; accountId: string; stage: string }) {
  return buildKeyPolicy(input, { operator: 'StringNotEquals', value: input.stage });
}

/** For the shared preview key: no single stage is pinned, any `pr*` stage's tagged roles qualify. */
export function secretsAtRestPreviewKeyPolicy(input: { partition: string; accountId: string }) {
  const policy = buildKeyPolicy(input, { operator: 'StringNotLike', value: PREVIEW_STAGE_PATTERN });
  return {
    ...policy,
    Statement: [
      ...policy.Statement,
      {
        // The pr* glob admits every preview stage, so also bind the context stage to the caller's own
        // stage tag: one preview's roles cannot unwrap another preview's blob.
        Sid: 'DenyDecryptOtherStageContext',
        Effect: 'Deny',
        Principal: '*',
        Action: ['kms:Decrypt'],
        Resource: '*',
        Condition: {
          StringNotEquals: {
            'kms:EncryptionContext:stage': `\${aws:PrincipalTag/${SECRETS_AT_REST_ROLE_TAG}}`,
          },
        },
      },
    ],
  };
}

/**
 * Matches a Decrypt on the key that the key policy or the IAM grant refused. The policy decides who may
 * decrypt, so the alarm keys on the refusal, not on a caller name that a session or a truncated
 * Function name could spoof or miss.
 */
export function secretsAtRestDecryptDeniedEventPattern(input: { keyArn: string }) {
  return {
    source: ['aws.kms'],
    'detail-type': ['AWS API Call via CloudTrail'],
    detail: {
      eventSource: ['kms.amazonaws.com'],
      eventName: ['Decrypt'],
      errorCode: ['AccessDenied', 'AccessDeniedException'],
      // A refused call has no `resources` or `requestParameters` in CloudTrail; only the message names the key.
      errorMessage: [{ wildcard: `*${input.keyArn}*` }],
    },
  };
}

export const SECRETS_AT_REST_KMS_EVENT_NAMES = [
  'PutKeyPolicy',
  'CreateGrant',
  'ScheduleKeyDeletion',
  'DisableKey',
  'DisableKeyRotation',
];

export function secretsAtRestKeyChangeEventPattern(input: { keyId: string; keyArn: string }) {
  return {
    source: ['aws.kms'],
    'detail-type': ['AWS API Call via CloudTrail'],
    detail: {
      eventSource: ['kms.amazonaws.com'],
      eventName: SECRETS_AT_REST_KMS_EVENT_NAMES,
      requestParameters: { keyId: [input.keyId, input.keyArn] },
    },
  };
}

export function secretsAtRestLogsPolicy(logGroupArn: string) {
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Sid: 'EventBridgeWriteAccessEvents',
        Effect: 'Allow',
        Principal: { Service: ['events.amazonaws.com', 'delivery.logs.amazonaws.com'] },
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: `${logGroupArn}:*`,
      },
    ],
  };
}

/** IAM grant for a Function or ECS task; the key policy and the context condition narrow it further. */
export function secretsAtRestDecryptPermission(keyArn: $util.Input<string>, stage: string) {
  const context = secretsAtRestEncryptionContext(stage);
  return {
    actions: ['kms:Decrypt'],
    resources: [keyArn],
    conditions: [
      { test: 'StringEquals', variable: 'kms:EncryptionContext:purpose', values: [context.purpose] },
      { test: 'StringEquals', variable: 'kms:EncryptionContext:stage', values: [context.stage] },
    ],
  };
}

export interface SecretsAtRestKey {
  kind: Exclude<SecretsAtRestKeyKind, 'none'>;
  arn: $util.Input<string>;
  /** Only on a dedicated key; the shared preview key is owned elsewhere. */
  key?: aws.kms.Key;
}

function createKey(): SecretsAtRestKey {
  const prefix = `${$app.name}-${$app.stage}`;
  const partition = aws.getPartitionOutput().partition;
  const accountId = aws.getCallerIdentityOutput().accountId;
  const key = new aws.kms.Key('SecretsAtRestKey', {
    description: `${prefix} secrets at rest data key wrapping`,
    enableKeyRotation: true,
    deletionWindowInDays: 30,
    policy: $resolve([partition, accountId]).apply(([p, account]) =>
      JSON.stringify(secretsAtRestKeyPolicy({ partition: p, accountId: account, stage: $app.stage }))
    ),
  });
  new aws.kms.Alias('SecretsAtRestKeyAlias', {
    name: `alias/${prefix}-secrets-at-rest`,
    targetKeyId: key.keyId,
  });
  return { kind: 'dedicated', arn: key.arn, key };
}

export function resolveSecretsAtRestKey(): SecretsAtRestKey | undefined {
  const previewKeyArn = process.env.PREVIEW_SECRETS_AT_REST_KEY_ARN || undefined;
  const kind = secretsAtRestKeyKind({ runsScheduledJobs, isPreviewStage, previewKeyArn });
  if (kind === 'dedicated') return createKey();
  if (kind === 'shared') return { kind, arn: previewKeyArn! };
  return undefined;
}

export const secretsAtRestKey: SecretsAtRestKey | undefined = resolveSecretsAtRestKey();
