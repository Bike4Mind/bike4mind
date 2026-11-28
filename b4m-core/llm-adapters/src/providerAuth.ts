import type { ProviderCredentialMode } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/** Providers resolved from a shared admin-setting key by @bike4mind/auth. */
export type SharedKeySources = Readonly<{
  openai: boolean;
  anthropic: boolean;
}>;

export type FederatableProvider = keyof SharedKeySources;

type FederatableKeys = { openai?: string | symbol | null; anthropic?: string | symbol | null };

/** How one provider's key in a marked table authenticates; see withProviderCredentialPlan. */
type PlannedCredential = 'federated' | 'static' | 'user_key';
type ProviderCredentialPlan = Readonly<Partial<Record<FederatableProvider, PlannedCredential>>>;

const credentialPlans = new WeakMap<object, ProviderCredentialPlan>();

/**
 * The deploy-time federation capability (infra/providerFederation.ts): IAM permission, provider
 * ids and token source are in place. It does not switch federation on; the per-provider
 * `<provider>CredentialMode` admin setting does.
 */
export const isFederatedProviderAuth = (): boolean => process.env.B4M_PROVIDER_AUTH === 'federated';

/** Any stored value other than `federated` (including a missing or mistyped one) means static. */
export const parseProviderCredentialMode = (value: unknown): ProviderCredentialMode =>
  value === 'federated' ? 'federated' : 'static';

/** Federation provenance for a table retaining static key values; key strings never grant it. */
export const federatedSharedKeyProviders = (keys: object): SharedKeySources | undefined => {
  const plan = credentialPlans.get(keys);
  return plan && { openai: plan.openai === 'federated', anthropic: plan.anthropic === 'federated' };
};

const warnedMissingCapability = new Set<FederatableProvider>();

/** Test seam: forget which providers already logged the missing-capability warning. */
export const resetProviderCredentialWarnings = (): void => warnedMissingCapability.clear();

export interface ProviderCredentialPlanInput {
  /** Providers whose key is the platform admin-setting key (auth's sharedAdminKeyProviders). */
  platformKeys: SharedKeySources | undefined;
  /** Providers whose key is the user's own saved key (auth's userKeyProviders). */
  userKeys: ReadonlySet<string>;
  modes: Readonly<Record<FederatableProvider, ProviderCredentialMode>>;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Mark a copy of `keys` with how each direct provider authenticates, while retaining static
 * values for availability checks. Federation applies only to a platform key, and only when its
 * mode is `federated` AND the deploy grants the capability. Direct SDK consumers keep the
 * original, unmarked table; an unmarked table's key strings all count as `static`.
 */
export function withProviderCredentialPlan<T extends FederatableKeys>(keys: T, input: ProviderCredentialPlanInput): T {
  if (!input.platformKeys && input.userKeys.size === 0) return keys;
  const plan: Partial<Record<FederatableProvider, PlannedCredential>> = {};
  for (const provider of ['openai', 'anthropic'] as const) {
    const key = keys[provider];
    if (typeof key !== 'string' || !key || key === 'expired') continue;
    if (input.userKeys.has(provider)) plan[provider] = 'user_key';
    else if (input.platformKeys?.[provider]) plan[provider] = platformCredential(provider, input);
  }
  if (Object.keys(plan).length === 0) return keys;
  const copy = { ...keys };
  credentialPlans.set(copy, Object.freeze(plan));
  return copy;
}

function platformCredential(provider: FederatableProvider, input: ProviderCredentialPlanInput): PlannedCredential {
  if (input.modes[provider] !== 'federated') return 'static';
  if (isFederatedProviderAuth()) return 'federated';
  if (!warnedMissingCapability.has(provider)) {
    warnedMissingCapability.add(provider);
    input.logger?.warn(
      `[providerAuth] ${provider}CredentialMode is "federated" but this deploy has no federation capability; using the static key`
    );
  }
  return 'static';
}

/**
 * What a direct-provider backend authenticates with, decided at dispatch. `federated` carries
 * the platform key it falls back to when the token exchange fails before a request is sent;
 * null (the bare federated sentinel, e.g. a CI job with no key) never falls back.
 */
export type ProviderCredentialSpec =
  | { kind: 'static'; key: string }
  | { kind: 'user_key'; key: string }
  | { kind: 'federated'; fallbackKey: string | null };

/** Narrow inferred symbol-valued tables without accepting arbitrary symbols as credentials. */
export function resolveProviderCredential<Sentinel extends symbol>(
  key: string | symbol,
  sentinel: Sentinel
): string | Sentinel {
  if (typeof key === 'string') return key;
  if (key === sentinel) return sentinel;
  throw new TypeError('Unrecognized federated provider credential');
}

/** The backend credential for `provider`'s key in `table`, following the table's credential plan. */
export function providerCredentialSpec<Sentinel extends symbol>(
  table: object,
  provider: FederatableProvider,
  key: string | symbol,
  sentinel: Sentinel
): ProviderCredentialSpec | Sentinel {
  const credential = resolveProviderCredential(key, sentinel);
  if (typeof credential !== 'string') return credential;
  switch (credentialPlans.get(table)?.[provider]) {
    case 'federated':
      return { kind: 'federated', fallbackKey: credential };
    case 'user_key':
      return { kind: 'user_key', key: credential };
    default:
      return { kind: 'static', key: credential };
  }
}

/** A backend constructor's credential argument, normalized; a plain string is a static key. */
export function normalizeProviderCredential<Sentinel extends symbol>(
  credential: string | Sentinel | ProviderCredentialSpec,
  sentinel: Sentinel
): ProviderCredentialSpec {
  if (typeof credential === 'string') return { kind: 'static', key: credential };
  if (typeof credential === 'symbol') {
    if (credential === sentinel) return { kind: 'federated', fallbackKey: null };
    throw new TypeError('Unrecognized federated provider credential');
  }
  if (isProviderCredentialSpec(credential)) return credential;
  throw new TypeError('Unrecognized provider credential');
}

function isProviderCredentialSpec(value: unknown): value is ProviderCredentialSpec {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  switch (value.kind) {
    case 'static':
    case 'user_key':
      return 'key' in value && typeof value.key === 'string';
    case 'federated':
      return 'fallbackKey' in value && (value.fallbackKey === null || typeof value.fallbackKey === 'string');
    default:
      return false;
  }
}
