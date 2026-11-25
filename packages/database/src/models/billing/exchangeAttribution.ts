import mongoose from 'mongoose';
import { CreditHolderType, type PayerStanding } from '@bike4mind/common';
import { UserApiKey } from '../auth/UserApiKeyModel';
import { Logger } from '@bike4mind/observability';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5_000;

type ExchangeKeyFacts = { oauthClientId: string; userId: string; payerStanding?: PayerStanding };

/** null is a key that is not an exchange key (or is gone), cached so personal-key charges cost one read a minute. */
const cache = new Map<string, { facts: ExchangeKeyFacts | null; expiresAt: number }>();

export type ExchangeAttributionFields = { oauthClientId?: string; payerStanding?: PayerStanding };

/** Mongoose keeps the active transaction session in this store; it is a real internal missing from its public types. */
function hasActiveTransaction(): boolean {
  const als = (
    mongoose as unknown as {
      transactionAsyncLocalStorage?: { getStore(): { session?: unknown } | undefined };
    }
  ).transactionAsyncLocalStorage;
  return als?.getStore()?.session != null;
}

export function clearExchangeAttributionCache(): void {
  cache.clear();
}

async function loadFacts(apiKeyId: string): Promise<ExchangeKeyFacts | null> {
  const key = await UserApiKey.findById(apiKeyId)
    .select('userId metadata.createdFrom metadata.oauthClientId metadata.payerStanding')
    .lean<{
      userId?: string;
      metadata?: { createdFrom?: string; oauthClientId?: string; payerStanding?: PayerStanding };
    } | null>();
  const metadata = key?.metadata;
  if (!key?.userId || metadata?.createdFrom !== 'oauth-exchange' || !metadata.oauthClientId) return null;
  return {
    oauthClientId: metadata.oauthClientId,
    userId: String(key.userId),
    ...(metadata.payerStanding ? { payerStanding: metadata.payerStanding } : {}),
  };
}

async function resolveFacts(apiKeyId: string): Promise<{ facts: ExchangeKeyFacts | null } | undefined> {
  const cached = cache.get(apiKeyId);
  if (cached && cached.expiresAt > Date.now()) return { facts: cached.facts };
  // A read inside a transaction joins it, and a failed read aborts the whole settlement.
  if (hasActiveTransaction()) {
    Logger.warn('[exchange-attribution] cold cache inside a transaction, attribution dropped', { apiKeyId });
    return undefined;
  }
  try {
    const facts = await loadFacts(apiKeyId);
    cache.delete(apiKeyId);
    cache.set(apiKeyId, { facts, expiresAt: Date.now() + CACHE_TTL_MS });
    if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    return { facts };
  } catch {
    Logger.warn('[exchange-attribution] key read failed, attribution dropped', { apiKeyId });
    return undefined;
  }
}

/**
 * Loads an exchange key's attribution into the cache. Call before opening a transaction that will
 * charge the key, because inside one a cold cache stamps nothing. Never throws.
 */
export async function warmExchangeAttribution(apiKeyId: string | null | undefined): Promise<void> {
  if (apiKeyId) await resolveFacts(apiKeyId);
}

/**
 * The app and payer standing to stamp on a charge made by `apiKeyId`. The app is recorded for any
 * exchange key; the standing only when the key's own owner paid, because chat and agents can bill the
 * owner's organization instead. Never throws; any failure yields no fields.
 */
export async function exchangeAttributionFor(
  apiKeyId: string,
  payer: { ownerType: CreditHolderType; ownerId: string }
): Promise<ExchangeAttributionFields> {
  const resolved = await resolveFacts(apiKeyId);
  const facts = resolved?.facts;
  if (!facts) return {};
  const ownerPaid = payer.ownerType === CreditHolderType.User && payer.ownerId === facts.userId;
  return {
    oauthClientId: facts.oauthClientId,
    ...(ownerPaid && facts.payerStanding ? { payerStanding: facts.payerStanding } : {}),
  };
}
