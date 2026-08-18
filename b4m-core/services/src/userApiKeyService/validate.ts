import { Logger } from '@bike4mind/observability';
import {
  ApiKeyBillingOwnerType,
  ApiKeyScope,
  ApiKeyStatus,
  IEmbedBranding,
  IUserApiKeyDocument,
  IUserApiKeyRepository,
} from '@bike4mind/common';
import bcrypt from 'bcryptjs';
import { KEY_PREFIX_LENGTH, LEGACY_KEY_PREFIX_LENGTH } from './constants';

interface ValidateUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
}

export interface ValidationResult {
  isValid: boolean;
  userId?: string;
  keyId?: string;
  scopes?: ApiKeyScope[];
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  productId?: string;
  /** Billing target of the key. Organization -> usage bills `organizationId`'s pool. */
  billingOwnerType?: ApiKeyBillingOwnerType;
  /** Organization the key bills, present iff billingOwnerType is Organization. */
  organizationId?: string;
  /** Agent an embed key is bound to, present iff scopes include `embed:chat`. */
  agentId?: string;
  /** Origins an embed key may be used from (defense-in-depth); embed keys only. */
  allowedOrigins?: string[];
  /** White-label config for an embed key; consumed by the widget serve route. */
  branding?: IEmbedBranding;
  /** Spend ceiling in credits for an embed key. Present 0 = real cap; absent = uncapped. */
  spendCap?: number;
  /** Cumulative settled spend in credits (`usage.totalSpendCredits`) at validation time. */
  currentSpend?: number;
  reason?: 'not_found' | 'invalid_hash' | 'expired' | 'disabled' | 'rate_limited';
}

/**
 * Post-lookup gates shared by every key-validation path (raw-key-by-prefix and
 * by-id). Runs the checks that must hold regardless of HOW the doc was located -
 * expiry, active status, the last-used bump - and returns the safe projection.
 * Centralized so a future gate (revoked flag, org-suspend, ...) can't land on one
 * path and silently skip the other.
 */
function finalizeApiKeyValidation(apiKey: IUserApiKeyDocument, db: ValidateUserApiKeyAdapters['db']): ValidationResult {
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return { isValid: false, reason: 'expired' };
  }
  if (apiKey.status !== ApiKeyStatus.ACTIVE) {
    return { isValid: false, reason: 'disabled' };
  }

  // Update last used timestamp (fire and forget)
  db.userApiKeys.updateLastUsed(apiKey.id).catch(err => {
    Logger.globalInstance.warn('Failed to update API key last used timestamp:', err);
  });

  return {
    isValid: true,
    userId: apiKey.userId,
    keyId: apiKey.id,
    scopes: apiKey.scopes,
    rateLimit: apiKey.rateLimit,
    productId: apiKey.productId,
    billingOwnerType: apiKey.billingOwnerType,
    organizationId: apiKey.organizationId,
    agentId: apiKey.agentId,
    allowedOrigins: apiKey.allowedOrigins,
    branding: apiKey.branding,
    spendCap: apiKey.spendCap,
    currentSpend: apiKey.usage?.totalSpendCredits,
  };
}

export const validateUserApiKey = async (
  key: string,
  adapters: ValidateUserApiKeyAdapters
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

  // Verify the hash
  const isHashValid = await bcrypt.compare(key, apiKey.keyHash);
  if (!isHashValid) {
    return { isValid: false, reason: 'invalid_hash' };
  }

  const result = finalizeApiKeyValidation(apiKey, db);

  // Self-heal legacy records: now that the full key is in hand (hash matched),
  // upgrade the stored prefix to the current length so future lookups hit directly
  // (fire and forget). Only heal a VALID key - matches the original ordering (gates
  // first) so an expired/disabled key isn't rewritten on every rejected request.
  // Prefix-specific to this path, so it stays here, not in the shared finalize helper.
  if (foundViaLegacyPrefix && result.isValid) {
    apiKey.keyPrefix = keyPrefix;
    db.userApiKeys.update(apiKey).catch(err => {
      Logger.globalInstance.warn('Failed to self-heal legacy API key prefix:', err);
    });
  }

  return result;
};

/**
 * Validate a key located BY ID - the embed session-token path holds the keyId but
 * not the raw secret, so there is no prefix lookup or bcrypt. It shares the exact
 * post-lookup gates (expiry, status, last-used) with validateUserApiKey via
 * finalizeApiKeyValidation, so the two paths cannot drift.
 */
export const validateUserApiKeyById = async (
  keyId: string,
  adapters: ValidateUserApiKeyAdapters
): Promise<ValidationResult> => {
  const apiKey = await adapters.db.userApiKeys.findById(keyId);
  if (!apiKey) {
    return { isValid: false, reason: 'not_found' };
  }
  return finalizeApiKeyValidation(apiKey, adapters.db);
};
