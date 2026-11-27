import { execFileSync } from 'node:child_process';
import { isPlaceholderValue, SECRETS_AT_REST_PURPOSE, WRAPPED_DATA_KEY_SECRET_NAME } from '@bike4mind/common';

/**
 * Mints the per-stage wrapped data key: asks KMS for an AES-256 data key under the stage's secrets-at-rest
 * key, keeps only the wrapped blob and stores it as the SECRET_DATA_KEY_WRAPPED SST secret.
 * The plaintext key is never returned (GenerateDataKeyWithoutPlaintext), and the blob is never printed.
 */

export const WRAPPED_SECRET_NAME = WRAPPED_DATA_KEY_SECRET_NAME;

/**
 * Reads a secret's own value from `sst secret list` output. The listing is sectioned: a `# fallback`
 * section of inherited values first, then the stage's own under a `# <app>/<stage>` header. Only values
 * outside the fallback section count. A multi-line value (a PEM key) never matches `NAME=`.
 */
export function parseSecretListing(listing: string, name: string): string | undefined {
  let inFallback = false;
  for (const line of listing.split('\n')) {
    if (line.startsWith('#')) inFallback = /^#\s*fallback\s*$/i.test(line);
    else if (!inFallback && line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim();
  }
  return undefined;
}

export const defaultKeyAlias = (appName: string, stage: string) => `alias/${appName}-${stage}-secrets-at-rest`;

type Exec = (
  cmd: string,
  args: string[],
  options: { encoding?: 'utf8'; input?: string; env: NodeJS.ProcessEnv }
) => unknown;

/**
 * Reads and writes the wrapped-key SST secret. sst takes the app name from SEED_APP_NAME, so it is passed
 * on every call to keep the secret on the same app as the key alias derived from --app.
 */
export function createSstSecretStore(appName: string, exec: Exec = execFileSync as Exec) {
  const env = { ...process.env, SEED_APP_NAME: appName };
  return {
    readSecret: async (stage: string) =>
      parseSecretListing(
        String(exec('npx', ['sst', 'secret', 'list', '--stage', stage], { encoding: 'utf8', env })),
        WRAPPED_SECRET_NAME
      ),
    // The value goes on stdin so the blob stays out of the process list and shell history.
    setSecret: async (stage: string, value: string) => {
      exec('npx', ['sst', 'secret', 'set', WRAPPED_SECRET_NAME, '--stage', stage], { input: value, env });
    },
  };
}

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
  isPreview: boolean;
}

export type WrappedKeyResult = 'already-set' | 'dry-run' | 'created';

export async function createWrappedStageDataKey(
  options: WrappedKeyOptions,
  deps: WrappedKeyDeps
): Promise<WrappedKeyResult> {
  const { stage, dryRun } = options;
  if (options.isPreview && !options.key) {
    throw new Error('--key is required on a preview stage: previews share one key, so there is no default alias');
  }
  const key = options.key ?? defaultKeyAlias(options.appName, stage);
  const context = { purpose: SECRETS_AT_REST_PURPOSE, stage };

  const current = await deps.readSecret(stage);
  if (!isPlaceholderValue(current)) {
    deps.log(
      `${WRAPPED_SECRET_NAME} is already set for stage ${stage}; nothing to do (the wrapped key is never replaced in place; see docs/architecture/secrets-at-rest-key.md)`
    );
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
