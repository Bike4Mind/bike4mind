import { Logger } from '@bike4mind/observability';
import {
  ApiKeyBillingOwnerType,
  ApiKeyStoredSecret,
  ApiKeyScopeValue,
  ApiKeyStatus,
  IEmbedBranding,
  IUserApiKeyDocument,
  IUserApiKeyRepository,
  isExchangeKeyMetadata,
} from '@bike4mind/common';
import bcrypt from 'bcryptjs';
import { KEY_PREFIX_LENGTH, LEGACY_KEY_PREFIX_LENGTH } from './constants';
import { computeKeyDigest, keyDigestMatches } from './keyDigest';

interface ValidateUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
}

export interface ValidateUserApiKeyOptions {
  /**
   * Whether this check is a use of the key, stamping its `lastUsedAt`. Defaults to true. Pass false
   * when the caller is only connecting or sending first-party telemetry, so an idle client never
   * makes a key look used.
   */
  recordUse?: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  userId?: string;
  keyId?: string;
  scopes?: ApiKeyScopeValue[];
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  expiresAt?: Date;
  productId?: string;
  /** Billing target of the key. Organization -> usage bills `organizationId`'s pool. */
  billingOwnerType?: ApiKeyBillingOwnerType;
  /** Organization the key bills, present iff billingOwnerType is Organization. */
  organizationId?: string;
  /** Agent an embed key is bound to, present iff scopes include `embed:chat`. */
  agentId?: string;
  /** Origins an embed key may be used from (defense-in-depth); embed keys only. */
  allowedOrigins?: string[];
  /** OAuth clients allowed to mint identified sessions on this embed key. */
  identifiedClientIds?: string[];
  /** Lake ids this key is bound to for the manage-but-not-member session admission. */
  preauthorizedLakeIds?: string[];
  /** White-label config for an embed key; consumed by the widget serve route. */
  branding?: IEmbedBranding;
  /** Spend ceiling in credits for an embed key. Present 0 = real cap; absent = uncapped. */
  spendCap?: number;
  /** Cumulative settled spend in credits (`usage.totalSpendCredits`) at validation time. */
  currentSpend?: number;
  /** The admin who provisioned the key for its owner (admin generate-api-key route only). */
  createdByUserId?: string;
  /** When the key was minted; rotation keeps it. Decides legacy status for grandfathered scope gates. */
  createdAt?: Date;
  /** OAuth client that minted the key, present only for a federated exchange key. */
  oauthExchangeClientId?: string;
  reason?: 'not_found' | 'invalid_hash' | 'expired' | 'disabled' | 'rate_limited';
}

/**
 * Checks `key` against the stored secret and returns the one it matched, or null. A key with a
 * stored digest is checked by constant-time SHA-256 compare only - the digest is authoritative, so a
 * mismatch never falls through to bcrypt. Keys minted before the digest existed fall back to the
 * bcrypt keyHash; a record with neither secret fails closed.
 */
async function matchStoredSecret(key: string, apiKey: IUserApiKeyDocument): Promise<ApiKeyStoredSecret | null> {
  if (apiKey.keyDigest) {
    return keyDigestMatches(key, apiKey.keyDigest) ? { keyDigest: apiKey.keyDigest } : null;
  }
  if (apiKey.keyHash) {
    return (await bcrypt.compare(key, apiKey.keyHash)) ? { keyHash: apiKey.keyHash } : null;
  }
  Logger.globalInstance.warn('API key record has neither keyDigest nor keyHash; rejecting', { keyId: apiKey.id });
  return null;
}

/** Stamps `lastUsedAt` without blocking the request; a failed write is logged, never thrown. */
export function recordUserApiKeyUse(keyId: string, db: ValidateUserApiKeyAdapters['db']): void {
  db.userApiKeys.updateLastUsed(keyId).catch(err => {
    Logger.globalInstance.warn('Failed to update API key last used timestamp:', err);
  });
}

/**
 * Post-lookup gates shared by every key-validation path (raw-key-by-prefix and
 * by-id). Runs the checks that must hold regardless of HOW the doc was located -
 * expiry, active status, the last-used bump - and returns the safe projection.
 * Centralized so a future gate (revoked flag, org-suspend, ...) can't land on one
 * path and silently skip the other.
 */
function finalizeApiKeyValidation(
  apiKey: IUserApiKeyDocument,
  db: ValidateUserApiKeyAdapters['db'],
  { recordUse = true }: ValidateUserApiKeyOptions
): ValidationResult {
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return { isValid: false, reason: 'expired' };
  }
  if (apiKey.status !== ApiKeyStatus.ACTIVE) {
    return { isValid: false, reason: 'disabled' };
  }
  // An exchange key with no client id cannot be confined or attributed, so refuse it.
  if (isExchangeKeyMetadata(apiKey.metadata) && !apiKey.metadata.oauthClientId) {
    return { isValid: false, reason: 'disabled' };
  }

  if (recordUse) recordUserApiKeyUse(apiKey.id, db);

  return {
    isValid: true,
    userId: apiKey.userId,
    keyId: apiKey.id,
    scopes: apiKey.scopes,
    rateLimit: apiKey.rateLimit,
    expiresAt: apiKey.expiresAt,
    productId: apiKey.productId,
    billingOwnerType: apiKey.billingOwnerType,
    organizationId: apiKey.organizationId,
    agentId: apiKey.agentId,
    allowedOrigins: apiKey.allowedOrigins,
    identifiedClientIds: apiKey.identifiedClientIds,
    preauthorizedLakeIds: apiKey.preauthorizedLakeIds,
    branding: apiKey.branding,
    spendCap: apiKey.spendCap,
    currentSpend: apiKey.usage?.totalSpendCredits,
    createdByUserId: apiKey.metadata?.createdByUserId,
    createdAt: apiKey.createdAt,
    oauthExchangeClientId: isExchangeKeyMetadata(apiKey.metadata) ? apiKey.metadata.oauthClientId : undefined,
  };
}

export const validateUserApiKey = async (
  key: string,
  adapters: ValidateUserApiKeyAdapters,
  options: ValidateUserApiKeyOptions = {}
): Promise<ValidationResult> => {
  const { db } = adapters;

  // Extract key prefix for lookup
  if (!key.startsWith('b4m_live_')) {
    return { isValid: false, reason: 'not_found' };
  }

  const keyPrefix = key.substring(0, KEY_PREFIX_LENGTH);

  // Find the API key by prefix. Keys minted before Jun 2026 are stored with a
  // 12-char prefix, so fall back to the legacy length on a miss.
  let apiKey = await db.userApiKeys.findActiveByKeyPrefix(keyPrefix);
  let foundViaLegacyPrefix = false;
  if (!apiKey) {
    apiKey = await db.userApiKeys.findActiveByKeyPrefix(key.substring(0, LEGACY_KEY_PREFIX_LENGTH));
    foundViaLegacyPrefix = apiKey !== null;
  }
  if (!apiKey) {
    return { isValid: false, reason: 'not_found' };
  }

  const matchedSecret = await matchStoredSecret(key, apiKey);
  if (!matchedSecret) {
    return { isValid: false, reason: 'invalid_hash' };
  }

  const result = finalizeApiKeyValidation(apiKey, db, options);

  // Self-heal legacy records: now that the full key is in hand (hash matched),
  // upgrade the stored prefix to the current length so future lookups hit directly
  // (fire and forget). Only heal a VALID key - matches the original ordering (gates
  // first) so an expired/disabled key isn't rewritten on every rejected request.
  // Prefix-specific to this path, so it stays here, not in the shared finalize helper.
  // Both heals pass the secret this request validated against, so a rotation that commits during
  // validation makes them no-ops instead of reviving the rotated-away key.
  if (foundViaLegacyPrefix && result.isValid) {
    apiKey.keyPrefix = keyPrefix;
    db.userApiKeys.healKeyPrefix(apiKey.id, keyPrefix, matchedSecret).catch(err => {
      Logger.globalInstance.warn('Failed to self-heal legacy API key prefix:', err);
    });
  }

  // Backfill the fast-path digest for a pre-digest key (fire and forget), same
  // valid-only rule as the prefix heal, so existing keys migrate on first use
  // without a rotation sweep.
  if ('keyHash' in matchedSecret && result.isValid) {
    const keyDigest = computeKeyDigest(key);
    apiKey.keyDigest = keyDigest;
    db.userApiKeys.setKeyDigest(apiKey.id, keyDigest, matchedSecret.keyHash).catch(err => {
      Logger.globalInstance.warn('Failed to backfill API key digest:', err);
    });
  }

  return result;
};

/**
 * The owner of a DISABLED key matching `key`, or null. Lets API-key auth answer a key that suspension
 * disabled (adminUpdateUser deactivates every key on suspend) with the owner's `account_suspended`
 * notice rather than a bare "Invalid API key". The secret must match, so a guessed prefix learns nothing.
 */
export const findOwnerOfDisabledUserApiKey = async (
  key: string,
  adapters: { db: { userApiKeys: Pick<IUserApiKeyRepository, 'findDisabledByKeyPrefix'> } }
): Promise<string | null> => {
  const findDisabled = adapters.db.userApiKeys.findDisabledByKeyPrefix;
  if (!findDisabled || !key.startsWith('b4m_live_')) return null;
  for (const prefixLength of [KEY_PREFIX_LENGTH, LEGACY_KEY_PREFIX_LENGTH]) {
    const candidates = await findDisabled.call(adapters.db.userApiKeys, key.substring(0, prefixLength));
    for (const candidate of candidates) {
      if (await matchStoredSecret(key, candidate)) return candidate.userId;
    }
  }
  return null;
};

/**
 * Validate a key located BY ID - the embed session-token path holds the keyId but
 * not the raw secret, so there is no prefix lookup or bcrypt. It shares the exact
 * post-lookup gates (expiry, status, last-used) with validateUserApiKey via
 * finalizeApiKeyValidation, so the two paths cannot drift.
 */
export const validateUserApiKeyById = async (
  keyId: string,
  adapters: ValidateUserApiKeyAdapters,
  options: ValidateUserApiKeyOptions = {}
): Promise<ValidationResult> => {
  const apiKey = await adapters.db.userApiKeys.findById(keyId);
  if (!apiKey) {
    return { isValid: false, reason: 'not_found' };
  }
  return finalizeApiKeyValidation(apiKey, adapters.db, options);
};
