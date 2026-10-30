/** Providers resolved from a shared admin-setting key by @bike4mind/auth. */
export type SharedKeySources = Readonly<{
  openai: boolean;
  anthropic: boolean;
}>;

type FederatableKeys = { openai?: string | symbol | null; anthropic?: string | symbol | null };

const federatedKeySources = new WeakMap<object, SharedKeySources>();

export const isFederatedProviderAuth = (): boolean => process.env.B4M_PROVIDER_AUTH === 'federated';

/** Federation provenance for a table retaining static key values; key strings never grant it. */
export const federatedSharedKeyProviders = (keys: object): SharedKeySources | undefined =>
  federatedKeySources.get(keys);

/**
 * Mark a copy for federated backend construction while retaining static values for availability
 * checks. Direct SDK consumers keep the original, unmarked table.
 */
export function withFederatedSharedKeys<T extends FederatableKeys>(keys: T, sources: SharedKeySources | undefined): T {
  if (!isFederatedProviderAuth() || !sources) return keys;
  const canFederate = (provider: keyof SharedKeySources) =>
    sources[provider] && !!keys[provider] && keys[provider] !== 'expired';
  const openai = canFederate('openai');
  const anthropic = canFederate('anthropic');
  if (!openai && !anthropic) return keys;
  const copy = { ...keys };
  federatedKeySources.set(copy, Object.freeze({ openai, anthropic }));
  return copy;
}

/** Narrow inferred symbol-valued tables without accepting arbitrary symbols as credentials. */
export function resolveProviderCredential<Sentinel extends symbol>(
  key: string | symbol,
  sentinel: Sentinel
): string | Sentinel {
  if (typeof key === 'string') return key;
  if (key === sentinel) return sentinel;
  throw new TypeError('Unrecognized federated provider credential');
}
