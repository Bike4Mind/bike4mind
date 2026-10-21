import { ANTHROPIC_FEDERATED_KEY } from './anthropicBackend';
import { OPENAI_FEDERATED_KEY } from './openaiBackend';

/**
 * Which providers' effective key is the shared admin-setting key, the only kind the federation
 * gate may replace. Produced by sharedAdminKeyProviders in @bike4mind/auth.
 */
export interface SharedKeySources {
  openai: boolean;
  anthropic: boolean;
}

type FederatableKeys = { openai?: string | null; anthropic?: string | null };

export const isFederatedProviderAuth = (): boolean => process.env.B4M_PROVIDER_AUTH === 'federated';

/**
 * With B4M_PROVIDER_AUTH=federated, a copy of `keys` whose shared admin keys are replaced by the
 * federation sentinels; otherwise `keys` itself. Pass the result only to getLlmByModel: direct-SDK
 * consumers of the original table (moderation, embeddings, images) cannot use the sentinel.
 */
export function withFederatedSharedKeys<T extends FederatableKeys>(keys: T, sources: SharedKeySources | undefined): T {
  if (!isFederatedProviderAuth() || !sources) return keys;
  const swap = (provider: keyof SharedKeySources) =>
    sources[provider] && !!keys[provider] && keys[provider] !== 'expired';
  const openai = swap('openai');
  const anthropic = swap('anthropic');
  if (!openai && !anthropic) return keys;
  return {
    ...keys,
    ...(openai ? { openai: OPENAI_FEDERATED_KEY } : {}),
    ...(anthropic ? { anthropic: ANTHROPIC_FEDERATED_KEY } : {}),
  };
}
