import {
  ApiKeyScope,
  ApiKeyScopeValue,
  CONFINED_API_KEY_SCOPES,
  isExchangeKeyMetadata,
  type IUserApiKeyMetadata,
} from '@bike4mind/common';
import { ForbiddenError } from '../utils/errors';
import { ALL_KNOWN_API_KEY_SCOPE_VALUES } from '../app/constants/apiKeyScopes';

/**
 * Env var naming the scopes whose route gates are still being rolled out, e.g.
 * `API_KEY_SCOPE_STAGING=optihashi:read,optihashi:compute`. Unset (the default)
 * means every declared `requiredScopes` gate enforces normally.
 *
 * This exists because declaring `requiredScopes` on a route that never had one
 * 403s every key already in production the moment it deploys - keys hold only
 * what they were minted with. The rollout is: declare the gate with the scope
 * staged, re-mint the keys in circulation, then drop the entry here. See
 * docs/architecture/api-key-scope-rollout.md.
 *
 * Scoped deliberately to the `baseApi`/`apiKeyAuth` gate. The other scope check -
 * `verifyApiKey` (server/cli/auth.ts), which backs Lambda-transport contract routes
 * (resolveContractAuth), the cc-bridge, and embed keys - has no staging path and
 * needs none: every gate it runs is either bound to a credential minted with that exact scope or belongs to
 * an endpoint that shipped with its scope from day one, so there is no
 * grandfathered population there to protect. Adding a second fail-open path would
 * be surface, not safety.
 */
export const SCOPE_STAGING_ENV_VAR = 'API_KEY_SCOPE_STAGING';

/**
 * The runtime view of {@link CONFINED_API_KEY_SCOPES} (the shared source of truth in
 * @bike4mind/common). A key holding nothing but these is *confined* - it authorizes
 * only the routes that explicitly name one of them, and never rides the scope-less
 * default in {@link decideScopeGate}. `createUserApiKey` enforces the mint half of the
 * same rule from the same constant.
 */
const CONFINED_SCOPES: ReadonlySet<string> = new Set<string>(CONFINED_API_KEY_SCOPES);

/**
 * Scopes that may never be staged. Staging `admin:*` would silently open every
 * admin-gated route to any valid key, and the confined scopes have no
 * grandfathered population to protect - each is bound to a credential minted
 * with it, so there is nothing a grace period could rescue.
 */
const UNSTAGEABLE_SCOPES: ReadonlySet<string> = new Set<string>([ApiKeyScope.ADMIN, ...CONFINED_SCOPES]);

/**
 * True when the key carries *any* confined scope.
 *
 * Deliberately `some`, not `every`: a key mixing `embed:chat` with an ordinary
 * scope is mintable today, and under `every` it would stay a full-account
 * credential on every scope-less route - the precise hole this closes. Such a key
 * still reaches whatever its ordinary scopes explicitly authorize; it just stops
 * inheriting the scope-less default.
 *
 * A key with no scopes at all is not confined - that is a legacy broad key, and
 * narrowing it here would be a silent revocation rather than a gate.
 */
function isConfinedKey(heldScopes: readonly ApiKeyScopeValue[] | undefined): boolean {
  return !!heldScopes?.some(scope => CONFINED_SCOPES.has(scope));
}

// Built-in plus contributed values. A contributed scope is never confined or unstageable: both sets
// above are built from built-in values only.
const ALL_SCOPE_VALUES: ReadonlySet<string> = ALL_KNOWN_API_KEY_SCOPE_VALUES;

export type LegacyApiKeyWindow = {
  /** Keys created before this are legacy. `null` until every route keys use has its scopes. */
  cutoff: Date | null;
  /** From this instant no key is legacy. `null` until the end date is announced. */
  endsAt: Date | null;
};

/**
 * The legacy API key window. A route that opts in with `grandfatherLegacyKeys` keeps
 * admitting legacy keys that lack its scopes, so scopes can land on routes keys already
 * reach without breaking existing keys. Until `cutoff` is set every key counts as legacy;
 * set both dates together once the scope map is final, and announce them to key owners.
 * Removed with the grandfathering code when the default flips to deny. See
 * docs/architecture/api-key-scope-rollout.md.
 */
export const LEGACY_API_KEY_WINDOW: Readonly<LegacyApiKeyWindow> = Object.freeze({ cutoff: null, endsAt: null });

/** Whether any key can still be legacy at `now`: false from `endsAt` on. */
export function isLegacyWindowOpen(
  now: Date = new Date(),
  window: Readonly<LegacyApiKeyWindow> = LEGACY_API_KEY_WINDOW
): boolean {
  return !window.endsAt || now < window.endsAt;
}

/**
 * Whether a key created at `createdAt` is legacy at `now`. Rotation keeps a key's id and
 * creation date, so a rotated key keeps its status: rotation never changes scopes, and
 * dropping the status there would break the key. A key with no creation date is legacy
 * only while no cutoff is set.
 */
export function isLegacyApiKey(
  createdAt: Date | undefined,
  now: Date = new Date(),
  window: Readonly<LegacyApiKeyWindow> = LEGACY_API_KEY_WINDOW
): boolean {
  if (!isLegacyWindowOpen(now, window)) return false;
  if (!window.cutoff) return true;
  return !!createdAt && createdAt < window.cutoff;
}

export type ApiKeyLegacyStatus = {
  /** The key would be grandfathered on a route that opts in with `grandfatherLegacyKeys`. */
  legacy: boolean;
  /** When legacy access ends; `null` for a non-legacy key or while no end date is set. */
  legacyEndsAt: Date | null;
};

/**
 * A key's legacy status as owners and admins see it. Mirrors the gate: a confined or
 * exchange key is never grandfathered (see {@link decideScopeGate}), so it is never
 * reported as legacy whatever its creation date.
 */
export function getApiKeyLegacyStatus(
  key: {
    createdAt?: Date;
    scopes?: readonly ApiKeyScopeValue[];
    metadata?: IUserApiKeyMetadata;
  },
  now: Date = new Date(),
  window: Readonly<LegacyApiKeyWindow> = LEGACY_API_KEY_WINDOW
): ApiKeyLegacyStatus {
  const legacy =
    !isExchangeKeyMetadata(key.metadata) && !isConfinedKey(key.scopes) && isLegacyApiKey(key.createdAt, now, window);
  return { legacy, legacyEndsAt: legacy ? window.endsAt : null };
}

export type ScopeGateDecision =
  /** The key holds a required scope, or the route declares none and the key is not confined. */
  | { outcome: 'allow' }
  /** No required scope held, and every one of them is staged - let it through, but say so. */
  | { outcome: 'stagedAllow'; stagedScopes: ApiKeyScopeValue[] }
  /** No required scope held, but the route grandfathers legacy keys and this one is - let it through, but say so. */
  | { outcome: 'legacyAllow' }
  /** No required scope held. */
  | { outcome: 'deny' };

/**
 * Parses {@link SCOPE_STAGING_ENV_VAR}. Entries that are not real scope values,
 * or that are listed in {@link UNSTAGEABLE_SCOPES}, are dropped and reported in
 * `rejected` so the caller can log them - a typo must not quietly read as "that
 * gate is staged".
 */
export function parseStagedScopes(raw: string | undefined): {
  staged: ReadonlySet<string>;
  rejected: string[];
} {
  const staged = new Set<string>();
  const rejected: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    if (ALL_SCOPE_VALUES.has(value) && !UNSTAGEABLE_SCOPES.has(value)) {
      staged.add(value);
    } else {
      rejected.push(value);
    }
  }
  return { staged, rejected };
}

export type ScopeGateOptions = {
  /** Route opts into `grandfatherLegacyKeys` and the key is a legacy key. Never overrides a confined or exchange key. */
  grandfathered?: boolean;
  /** Key was minted by the federated AI-token exchange. */
  exchangeKey?: boolean;
};

/**
 * The scope gate's whole decision, isolated from Express so it can be tested
 * directly.
 *
 * `requiredScopes` is OR semantics: holding any one of them passes. Staging is
 * therefore all-or-nothing across the list - a route is only in its grace period
 * when *every* alternative is still staged. If even one required scope is
 * already enforced, a key that legitimately needs the route could already have
 * been minted with it, so a key holding none of them is not grandfathered and is
 * denied.
 *
 * `alsoRequiredScopes` is AND semantics on top of that: every one of these must
 * be held, regardless of how the OR check above resolves - a route can require a
 * feature scope AND separately gate spend, which a single OR list cannot express
 * (see issue #2330). It has **no staging path**: unlike `requiredScopes`, which
 * exists to grandfather keys a newly-declared gate would otherwise 403, an AND
 * scope is only ever added to a route that is adopting it, so there is no
 * pre-existing population to protect - it enforces from day one. Checked first,
 * ahead of every other branch, so a missing AND scope can never be masked by an
 * OR match, a scope-less route's default allow, or a staged OR list.
 *
 * A route that declares no scopes still allows any ordinary key. The exception is
 * a {@link isConfinedKey} credential, which is denied there: it authorizes its own
 * flow and nothing else. Callers must therefore invoke this even when
 * `requiredScopes` is undefined.
 *
 * A key minted by the federated AI-token exchange (`exchangeKey`) is confined the same way, whatever
 * scopes it holds.
 *
 * A confined key can ONLY be allowed by an explicit `requiredScopes` match - the
 * confinement check sits above both the no-scope and the staged branch, so a
 * rollout window cannot admit one to a route it has no business on.
 *
 * `grandfathered` is true when the route opts into `grandfatherLegacyKeys` and the key is
 * {@link isLegacyApiKey}. It admits a key that misses `requiredScopes`, never one that
 * misses an AND scope and never a confined key: both are checked above it. A staged
 * pass wins over a legacy one, so the key lands on the staging backlog it belongs to.
 */
export function decideScopeGate(
  requiredScopes: ApiKeyScopeValue[] | undefined,
  heldScopes: readonly ApiKeyScopeValue[] | undefined,
  staged: ReadonlySet<string>,
  alsoRequiredScopes?: ApiKeyScopeValue[],
  options?: ScopeGateOptions & { grandfathered?: false }
): Exclude<ScopeGateDecision, { outcome: 'legacyAllow' }>;
export function decideScopeGate(
  requiredScopes: ApiKeyScopeValue[] | undefined,
  heldScopes: readonly ApiKeyScopeValue[] | undefined,
  staged: ReadonlySet<string>,
  alsoRequiredScopes: ApiKeyScopeValue[] | undefined,
  options: ScopeGateOptions
): ScopeGateDecision;
export function decideScopeGate(
  requiredScopes: ApiKeyScopeValue[] | undefined,
  heldScopes: readonly ApiKeyScopeValue[] | undefined,
  staged: ReadonlySet<string>,
  alsoRequiredScopes?: ApiKeyScopeValue[],
  options: ScopeGateOptions = {}
): ScopeGateDecision {
  const { grandfathered = false, exchangeKey = false } = options;
  if (alsoRequiredScopes?.some(scope => !heldScopes?.includes(scope))) {
    return { outcome: 'deny' };
  }
  if (requiredScopes?.some(scope => heldScopes?.includes(scope))) return { outcome: 'allow' };
  // Above both branches below: neither a missing declaration nor an active staging
  // window may admit a confined key.
  if (exchangeKey || isConfinedKey(heldScopes)) return { outcome: 'deny' };
  if (!requiredScopes) return { outcome: 'allow' };
  // An empty `requiredScopes` denies (a route asking for "one of nothing" can
  // satisfy nobody); `every` on [] is true, so guard the length explicitly.
  if (requiredScopes.length > 0 && requiredScopes.every(scope => staged.has(scope))) {
    return { outcome: 'stagedAllow', stagedScopes: requiredScopes };
  }
  if (grandfathered && requiredScopes.length > 0) return { outcome: 'legacyAllow' };
  return { outcome: 'deny' };
}

export type ScopedRequest = {
  apiKeyInfo?: {
    keyId?: string;
    scopes?: ApiKeyScopeValue[];
    createdAt?: Date;
    oauthExchangeClientId?: string;
  };
  logger?: { info: (message: string, context?: Record<string, unknown>) => void };
};

export type ScopeCheckOptions = {
  /** Admit legacy keys that lack the scope, as `baseApi`'s `grandfatherLegacyKeys` does at the door. */
  grandfatherLegacyKeys?: boolean;
};

/**
 * In-handler counterpart of `baseApi`'s `requiredScopes` gate, for a route whose methods
 * need different scopes (the gate is per route, not per method). Honors
 * API_KEY_SCOPE_STAGING, so a grandfathered key rides the same grace window it would at
 * the route gate. Family wrappers: ../files/fileScopes.ts, and in apps/client server/dataLakes/dataLakeScopes.ts,
 * server/projects/projectScopes.ts, server/agents/agentScopes.ts.
 *
 * A caller with no `apiKeyInfo` is a JWT/browser caller - the key gate never ran for them
 * and this must not either. The check is on `apiKeyInfo` itself, not on `scopes`: a key
 * caller whose `scopes` came back undefined (apiKeyAuth.ts writes `scopes: validation.scopes!`)
 * still has `apiKeyInfo` set, and letting a missing array through would fail open for exactly
 * the caller this gate exists to check.
 */
export function holdsApiKeyScope(
  req: ScopedRequest,
  required: ApiKeyScopeValue[],
  { grandfatherLegacyKeys = false }: ScopeCheckOptions = {}
): boolean {
  if (!req.apiKeyInfo) return true;
  const held = req.apiKeyInfo.scopes ?? [];
  const { staged } = parseStagedScopes(process.env[SCOPE_STAGING_ENV_VAR]);
  const grandfathered = grandfatherLegacyKeys && isLegacyApiKey(req.apiKeyInfo.createdAt);
  const { outcome } = decideScopeGate(required, held, staged, undefined, {
    grandfathered,
    exchangeKey: !!req.apiKeyInfo.oauthExchangeClientId,
  });
  if (outcome === 'legacyAllow' && shouldLogLegacyPass(req.apiKeyInfo.keyId, required.join(','))) {
    // Same line as apiKeyAuth's door, so one query finds every key still relying on the window.
    req.logger?.info(LEGACY_SCOPE_PASS_LOG, {
      keyId: req.apiKeyInfo.keyId,
      heldScopes: held,
      requiredScopes: required,
    });
  }
  return outcome !== 'deny';
}

/** Logged on grandfathered passes; the list of keys whose owners still need to re-create them. */
export const LEGACY_SCOPE_PASS_LOG = 'API key scope check missed but legacy key grandfathered - allowing';

const LEGACY_PASS_LOG_INTERVAL_MS = 60 * 60 * 1000;
const LEGACY_PASS_LOG_MAX_ENTRIES = 10_000;
const lastLegacyPassLog = new Map<string, number>();

/**
 * At most one log line per key and route (or scope set) per hour in each process: a busy key on
 * a hot route would otherwise log on every request, and the line is a list of keys, not a meter.
 */
export function shouldLogLegacyPass(keyId: string | undefined, where: string, now: number = Date.now()): boolean {
  const entry = `${keyId ?? ''}|${where}`;
  const last = lastLegacyPassLog.get(entry);
  if (last !== undefined && now - last < LEGACY_PASS_LOG_INTERVAL_MS) return false;
  if (lastLegacyPassLog.size >= LEGACY_PASS_LOG_MAX_ENTRIES) lastLegacyPassLog.clear();
  lastLegacyPassLog.set(entry, now);
  return true;
}

export function assertApiKeyScope(
  req: ScopedRequest,
  required: ApiKeyScopeValue[],
  message: string,
  options?: ScopeCheckOptions
): void {
  if (!holdsApiKeyScope(req, required, options)) throw new ForbiddenError(message);
}
