/**
 * Mints the per-stage wrapped data key: asks KMS for an AES-256 data key under the stage's secrets-at-rest
 * key, keeps only the wrapped blob and stores it as the SECRET_ENCRYPTION_KEY_WRAPPED SST secret.
 * The plaintext key is never returned (GenerateDataKeyWithoutPlaintext), and the blob is never printed.
 */

/** Must stay in sync with SECRETS_AT_REST_PURPOSE in infra/secretsAtRestKey.ts (a test reads both files). */
export const SECRETS_AT_REST_PURPOSE = 'secrets-at-rest';

export const WRAPPED_SECRET_NAME = 'SECRET_ENCRYPTION_KEY_WRAPPED';
/** The infra default for an unset secret. */
export const UNSET_SECRET_VALUE = 'not-configured';

export const defaultKeyAlias = (appName: string, stage: string) => `alias/${appName}-${stage}-secrets-at-rest`;

export interface WrappedKeyDeps {
  /** Current value of the stage secret, or undefined when it is not listed. */
  readSecret: (stage: string) => Promise<string | undefined>;
  /** Throws when the key is missing; returns whether it is enabled. */
  describeKey: (key: string) => Promise<{ enabled: boolean; arn: string }>;
  generateWrappedKey: (key: string, context: Record<string, string>) => Promise<Uint8Array>;
  setSecret: (stage: string, value: string) => Promise<void>;
  log: (line: string) => void;
}

export interface WrappedKeyOptions {
  stage: string;
  /** Alias or ARN; defaults to the stage's dedicated alias. Required on previews, which share a key. */
  key?: string;
  appName: string;
  dryRun: boolean;
  force: boolean;
  isPreview: boolean;
}

export type WrappedKeyResult = 'already-set' | 'dry-run' | 'created';

export async function createWrappedStageDataKey(
  options: WrappedKeyOptions,
  deps: WrappedKeyDeps
): Promise<WrappedKeyResult> {
  const { stage, dryRun, force } = options;
  if (options.isPreview && !options.key) {
    throw new Error('--key is required on a preview stage: previews share one key, so there is no default alias');
  }
  const key = options.key ?? defaultKeyAlias(options.appName, stage);
  const context = { purpose: SECRETS_AT_REST_PURPOSE, stage };

  const current = await deps.readSecret(stage);
  if (current !== undefined && current !== UNSET_SECRET_VALUE && !force) {
    deps.log(`${WRAPPED_SECRET_NAME} is already set for stage ${stage}; nothing to do (use --force to replace it)`);
    return 'already-set';
  }

  const described = await deps.describeKey(key);
  if (!described.enabled) throw new Error(`KMS key ${key} is not enabled`);

  if (dryRun) {
    deps.log(
      `[dry-run] would generate a wrapped AES_256 data key under ${key} with context ${JSON.stringify(context)} ` +
        `and set ${WRAPPED_SECRET_NAME} for stage ${stage}`
    );
    return 'dry-run';
  }

  const blob = await deps.generateWrappedKey(key, context);
  await deps.setSecret(stage, Buffer.from(blob).toString('base64'));
  deps.log(`Set ${WRAPPED_SECRET_NAME} for stage ${stage} (wrapped under ${described.arn})`);
  return 'created';
}
