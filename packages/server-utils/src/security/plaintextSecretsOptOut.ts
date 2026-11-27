import type { Logger } from '@bike4mind/observability';
import { isValidEncryptionKey } from './secretEncryption';

/**
 * True when a self-host install runs keyless on purpose: B4M_ALLOW_PLAINTEXT_SECRETS is exactly
 * `true` and there is no valid SECRET_ENCRYPTION_KEY. Must stay in sync with the startup check in
 * selfhost/kubernetes/files/validate-secrets.cjs.
 */
export function isPlaintextSecretsOptOutActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.B4M_ALLOW_PLAINTEXT_SECRETS === 'true' && !isValidEncryptionKey(env.SECRET_ENCRYPTION_KEY ?? '');
}

/** Logs one loud boot WARN when the plaintext opt-out is in effect. */
export function warnIfPlaintextSecretsOptOut(logger: Pick<Logger, 'warn'>, env: NodeJS.ProcessEnv = process.env): void {
  if (!isPlaintextSecretsOptOutActive(env)) return;
  logger.warn(
    'B4M_ALLOW_PLAINTEXT_SECRETS=true and no valid SECRET_ENCRYPTION_KEY: stored secrets are kept in PLAINTEXT. ' +
      'Evaluation only; set SECRET_ENCRYPTION_KEY (see SELF_HOST.md).'
  );
}
