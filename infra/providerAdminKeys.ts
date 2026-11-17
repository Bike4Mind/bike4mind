/**
 * Dedicated store for the provider admin keys the spend crons read at runtime: one customer-managed
 * KMS key and one Secrets Manager secret per provider. The secret values are set by hand outside
 * IaC, so no secret version is declared and no value appears in code or state. The access policy and
 * the alarms on the store live in infra/providerSpend.ts.
 *
 * Imports only constants so infra/cron.ts can import it without a cycle.
 */

import { runsScheduledJobs } from './constants';

/** Must stay in sync with AdminKeyProvider in apps/workers/src/cron/providerAdminKey.ts. */
export const PROVIDER_ADMIN_KEY_PROVIDERS = ['anthropic', 'openai'] as const;
export type ProviderAdminKeyProvider = (typeof PROVIDER_ADMIN_KEY_PROVIDERS)[number];

/** Must match the env var read by resolveProviderAdminKey in apps/workers/src/cron/providerAdminKey.ts. */
export const providerAdminKeyEnvName = (provider: ProviderAdminKeyProvider) =>
  `PROVIDER_ADMIN_KEY_SECRET_${provider.toUpperCase()}`;

export const providerAdminKeySecretName = (appName: string, stage: string, provider: ProviderAdminKeyProvider) =>
  `${appName}/${stage}/provider-admin-key/${provider}`;

export interface ProviderAdminKeyStore {
  key: aws.kms.Key;
  secrets: Record<ProviderAdminKeyProvider, aws.secretsmanager.Secret>;
}

const POLICY_VERSION = '2012-10-17';

export function providerAdminKeyPolicy(partition: string, accountId: string, region: string) {
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Sid: 'EnableAccountAdministration',
        Effect: 'Allow',
        Principal: { AWS: `arn:${partition}:iam::${accountId}:root` },
        Action: 'kms:*',
        Resource: '*',
      },
      {
        Sid: 'DenyUseOutsideSecretsManager',
        Effect: 'Deny',
        Principal: '*',
        Action: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*'],
        Resource: '*',
        Condition: { StringNotEquals: { 'kms:ViaService': `secretsmanager.${region}.amazonaws.com` } },
      },
    ],
  };
}

/**
 * Resource policy for each secret: only the spend cron roles read the value and replication is
 * refused. Changing or removing the policy itself stays allowed and is alarmed instead, so the
 * secret cannot be locked out of administration.
 */
export function providerAdminKeySecretPolicy(readerRoleArns: string[]) {
  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Sid: 'DenyReadOutsideSpendCrons',
        Effect: 'Deny',
        Principal: '*',
        Action: 'secretsmanager:GetSecretValue',
        Resource: '*',
        Condition: { ArnNotEquals: { 'aws:PrincipalArn': readerRoleArns } },
      },
      {
        Sid: 'DenyReplication',
        Effect: 'Deny',
        Principal: '*',
        Action: 'secretsmanager:ReplicateSecretToRegions',
        Resource: '*',
      },
    ],
  };
}

export function providerAdminKeyLogsPolicy(logGroupArn: string) {
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

export interface ProviderAdminKeySecretRef {
  name: string;
  arn: string;
}

/** A secret ARN without the 6-character suffix Secrets Manager appends, which callers may omit. */
export const secretArnWithoutSuffix = (arn: string) => arn.replace(/-[A-Za-z0-9]{6}$/, '');

/** Callers may pass the secret by name, by full ARN or by partial ARN. */
const secretIdMatchers = (secrets: ProviderAdminKeySecretRef[]) =>
  secrets.flatMap(({ name, arn }) => [name, { prefix: secretArnWithoutSuffix(arn) }]);

const SECRETS_MANAGER_SOURCE = {
  source: ['aws.secretsmanager'],
  'detail-type': ['AWS API Call via CloudTrail'],
};

export function providerAdminKeyReadEventPattern(input: {
  secrets: ProviderAdminKeySecretRef[];
  allowedRoleArns: string[];
}) {
  return {
    ...SECRETS_MANAGER_SOURCE,
    detail: {
      eventSource: ['secretsmanager.amazonaws.com'],
      eventName: ['GetSecretValue'],
      requestParameters: { secretId: secretIdMatchers(input.secrets) },
      // anything-but does not match an absent field, so callers that are not roles need their own branch.
      $or: [
        { userIdentity: { sessionContext: { sessionIssuer: { arn: [{ 'anything-but': input.allowedRoleArns }] } } } },
        { userIdentity: { type: [{ 'anything-but': ['AssumedRole'] }] } },
      ],
    },
  };
}

export const PROVIDER_ADMIN_KEY_CHANGE_EVENT_NAMES = [
  'PutSecretValue',
  'UpdateSecret',
  'UpdateSecretVersionStage',
  'PutResourcePolicy',
  'DeleteResourcePolicy',
  'DeleteSecret',
  'RestoreSecret',
  'RotateSecret',
  'ReplicateSecretToRegions',
];

export function providerAdminKeyChangeEventPattern(input: { secrets: ProviderAdminKeySecretRef[] }) {
  return {
    ...SECRETS_MANAGER_SOURCE,
    detail: {
      eventSource: ['secretsmanager.amazonaws.com'],
      eventName: PROVIDER_ADMIN_KEY_CHANGE_EVENT_NAMES,
      requestParameters: { secretId: secretIdMatchers(input.secrets) },
    },
  };
}

export const PROVIDER_ADMIN_KEY_KMS_EVENT_NAMES = [
  'PutKeyPolicy',
  'CreateGrant',
  'ScheduleKeyDeletion',
  'DisableKey',
  'DisableKeyRotation',
];

export function providerAdminKeyKmsEventPattern(input: { keyId: string; keyArn: string }) {
  return {
    source: ['aws.kms'],
    'detail-type': ['AWS API Call via CloudTrail'],
    detail: {
      eventSource: ['kms.amazonaws.com'],
      eventName: PROVIDER_ADMIN_KEY_KMS_EVENT_NAMES,
      requestParameters: { keyId: [input.keyId, input.keyArn] },
    },
  };
}

interface ProviderAdminKeyCronAccess {
  environment: Record<string, aws.secretsmanager.Secret['arn']>;
  permissions: { actions: string[]; resources: aws.secretsmanager.Secret['arn'][] }[];
}

/**
 * Env vars and IAM permissions for a cron that reads the store: the secret ARNs and nothing wider.
 * Empty where the store does not exist, so the cron falls back to the linked Config secret.
 */
export function providerAdminKeyCronAccess(store: ProviderAdminKeyStore | undefined): ProviderAdminKeyCronAccess {
  if (!store) return { environment: {}, permissions: [] };
  return {
    environment: Object.fromEntries(
      PROVIDER_ADMIN_KEY_PROVIDERS.map(provider => [providerAdminKeyEnvName(provider), store.secrets[provider].arn])
    ),
    permissions: [
      {
        actions: ['secretsmanager:GetSecretValue'],
        resources: PROVIDER_ADMIN_KEY_PROVIDERS.map(provider => store.secrets[provider].arn),
      },
      { actions: ['kms:Decrypt'], resources: [store.key.arn] },
    ],
  };
}

function createStore(): ProviderAdminKeyStore {
  const partition = aws.getPartitionOutput().partition;
  const accountId = aws.getCallerIdentityOutput().accountId;
  const region = aws.getRegionOutput().name;
  const prefix = `${$app.name}-${$app.stage}`;

  const key = new aws.kms.Key('ProviderAdminKeys', {
    description: `${prefix} provider admin key secrets`,
    enableKeyRotation: true,
    policy: $resolve([partition, accountId, region]).apply(([currentPartition, account, currentRegion]) =>
      JSON.stringify(providerAdminKeyPolicy(currentPartition, account, currentRegion))
    ),
  });

  new aws.kms.Alias('ProviderAdminKeysAlias', {
    name: `alias/${prefix}-provider-admin-keys`,
    targetKeyId: key.keyId,
  });

  const secrets = Object.fromEntries(
    PROVIDER_ADMIN_KEY_PROVIDERS.map(provider => [
      provider,
      new aws.secretsmanager.Secret(`ProviderAdminKey-${provider}`, {
        name: providerAdminKeySecretName($app.name, $app.stage, provider),
        description: `${provider} admin API key read by the spend crons; the value is set outside IaC`,
        kmsKeyId: key.arn,
      }),
    ])
  ) as ProviderAdminKeyStore['secrets'];

  return { key, secrets };
}

export const providerAdminKeyStore: ProviderAdminKeyStore | undefined = runsScheduledJobs ? createStore() : undefined;
