/**
 * KMS key that wraps the per-stage data key for secrets stored at rest. Production and staging
 * (`dev`) own a dedicated key; preview stages share one key owned outside any stage and passed by
 * ARN (same ownership pattern as the shared preview certificate); other stages have no key.
 *
 * The key policy, event patterns and IAM grant are pure builders so they can be unit tested.
 * Imports only constants so sst.config.ts can load it before ./infra without a cycle. The access
 * policy and the alarms live in infra/secretsAtRestKeyAccess.ts, because they need the ECS task
 * role ARNs, which in turn depend on this key's ARN.
 */

import { isPreviewStage, runsScheduledJobs } from './constants';

export const SECRETS_AT_REST_PURPOSE = 'secrets-at-rest';

/** Must match the KMS encryption context packages/scripts/src/createWrappedStageDataKey.ts mints with. */
export const secretsAtRestEncryptionContext = (stage: string) => ({ purpose: SECRETS_AT_REST_PURPOSE, stage });

export const SECRETS_AT_REST_PREVIEW_KEY_ENV = 'PREVIEW_SECRETS_AT_REST_KEY_ARN';

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

/** Function names are `<app>-<stage>-<name>`; the Decrypt condition and the alarm both key on this prefix. */
export const secretsAtRestFunctionNamePrefix = (appName: string, stage: string) => `${appName}-${stage}-`;

export function secretsAtRestKeyPolicy(input: {
  partition: string;
  accountId: string;
  region: string;
  appName: string;
  stage: string;
  ecsRoleArns: string[];
  /** False on the shared preview key, which serves many stages. */
  pinStage: boolean;
}) {
  const functionArnPattern = `arn:${input.partition}:lambda:${input.region}:${input.accountId}:function:${secretsAtRestFunctionNamePrefix(input.appName, input.stage)}*`;
  const notApp: Record<string, Record<string, string | string[]>> = {
    ArnNotLike: { 'lambda:SourceFunctionArn': functionArnPattern },
  };
  if (input.ecsRoleArns.length > 0) notApp.ArnNotEquals = { 'aws:PrincipalArn': input.ecsRoleArns };

  const contextDenies = [
    {
      Sid: 'DenyWithoutPurposeContext',
      Effect: 'Deny',
      Principal: '*',
      Action: ['kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKeyWithoutPlaintext'],
      Resource: '*',
      Condition: { StringNotEquals: { 'kms:EncryptionContext:purpose': SECRETS_AT_REST_PURPOSE } },
    },
    ...(input.pinStage
      ? [
          {
            Sid: 'DenyWithoutStageContext',
            Effect: 'Deny',
            Principal: '*',
            Action: ['kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKeyWithoutPlaintext'],
            Resource: '*',
            Condition: { StringNotEquals: { 'kms:EncryptionContext:stage': input.stage } },
          },
        ]
      : []),
  ];

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
      ...contextDenies,
      {
        // Operators mint the wrapped blob with GenerateDataKeyWithoutPlaintext but can never unwrap it.
        Sid: 'DenyDecryptOutsideApp',
        Effect: 'Deny',
        Principal: '*',
        Action: ['kms:Decrypt', 'kms:ReEncrypt*'],
        Resource: '*',
        Condition: notApp,
      },
    ],
  };
}

/** Matches a Decrypt on the key by a caller that is neither this stage's Function nor one of its ECS task roles. */
export function secretsAtRestDecryptOutsideAppEventPattern(input: {
  keyArn: string;
  appName: string;
  stage: string;
  ecsRoleArns: string[];
}) {
  const functionNames = `*/${secretsAtRestFunctionNamePrefix(input.appName, input.stage)}*`;
  const notEcsRole =
    input.ecsRoleArns.length > 0
      ? { sessionContext: { sessionIssuer: { arn: [{ 'anything-but': input.ecsRoleArns }] } } }
      : {};
  return {
    source: ['aws.kms'],
    'detail-type': ['AWS API Call via CloudTrail'],
    detail: {
      eventSource: ['kms.amazonaws.com'],
      eventName: ['Decrypt'],
      resources: { ARN: [input.keyArn] },
      // anything-but does not match an absent field, so callers that are not roles need their own branch.
      $or: [
        {
          userIdentity: {
            arn: [{ 'anything-but': { wildcard: [functionNames] } }],
            ...notEcsRole,
          },
        },
        { userIdentity: { type: [{ 'anything-but': ['AssumedRole'] }] } },
      ],
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
  // The real policy is attached by infra/secretsAtRestKeyAccess.ts once the ECS role ARNs exist.
  const key = new aws.kms.Key('SecretsAtRestKey', {
    description: `${prefix} secrets at rest data key wrapping`,
    enableKeyRotation: true,
    deletionWindowInDays: 30,
  });
  new aws.kms.Alias('SecretsAtRestKeyAlias', {
    name: `alias/${prefix}-secrets-at-rest`,
    targetKeyId: key.keyId,
  });
  return { kind: 'dedicated', arn: key.arn, key };
}

export function resolveSecretsAtRestKey(): SecretsAtRestKey | undefined {
  const previewKeyArn = process.env[SECRETS_AT_REST_PREVIEW_KEY_ENV] || undefined;
  const kind = secretsAtRestKeyKind({ runsScheduledJobs, isPreviewStage, previewKeyArn });
  if (kind === 'dedicated') return createKey();
  if (kind === 'shared') return { kind, arn: previewKeyArn! };
  return undefined;
}

export const secretsAtRestKey: SecretsAtRestKey | undefined = resolveSecretsAtRestKey();
