import type { Logger } from '@bike4mind/observability';
import type { ProviderCredentialSpec } from './providerAuth';
import { recordProviderCredentialUse, type CredentialProvider } from './providerCredentialMetrics';

/**
 * The credential one provider request goes out with, fixed BEFORE the request is sent. Only a
 * failure up to this point (building the federated client, or the token exchange itself) may
 * fall back to the static key: once a request is sent, any error (5xx, a dead stream) is the
 * caller's, never a reason to resend with another credential, which would double-send and
 * double-bill.
 */
export type ResolvedProviderCredential =
  | { kind: 'federated' }
  | { kind: 'static' | 'user_key'; key: string }
  | { kind: 'static_fallback'; key: string; cause: unknown };

export interface ResolveCredentialInput {
  provider: CredentialProvider;
  spec: ProviderCredentialSpec;
  /** Set when the federated client could not be built at construction; skips the exchange. */
  setupError: unknown;
  /**
   * Completes the token exchange now, so the SDK's own lazy exchange inside the request reads a
   * cached token. Throws when the exchange fails.
   */
  exchange: () => Promise<void>;
  logger: Pick<Logger, 'warn'>;
}

/**
 * Resolve the credential for one request and record it on the ProviderCredentialUse metric:
 * exactly one of static / user_key / federated / static_fallback per resolved request. A
 * federated spec with no fallback key rethrows the exchange failure and records nothing.
 */
export async function resolveCredentialBeforeSend(input: ResolveCredentialInput): Promise<ResolvedProviderCredential> {
  const resolved = await resolve(input);
  recordProviderCredentialUse(input.provider, resolved.kind);
  return resolved;
}

async function resolve({
  provider,
  spec,
  setupError,
  exchange,
  logger,
}: ResolveCredentialInput): Promise<ResolvedProviderCredential> {
  if (spec.kind !== 'federated') return spec;
  let cause = setupError;
  if (cause === undefined) {
    try {
      await exchange();
      return { kind: 'federated' };
    } catch (err) {
      cause = err;
    }
  }
  if (spec.fallbackKey === null) throw cause;
  logger.warn(
    `[providerCredential] ${provider} federated token exchange failed; using the static key for this request`,
    {
      error: cause instanceof Error ? cause.message : String(cause),
    }
  );
  return { kind: 'static_fallback', key: spec.fallbackKey, cause };
}
