import {
  apiKeyRepository,
  adminSettingsRepository,
  Memento,
  memoryLedgerRepository,
  memoryPrincipalKeyRepository,
} from '@bike4mind/database';
import {
  MEMENTO_EMBEDDING_ID,
  MEMENTO_EMBEDDING_MODEL,
  mementoEmbeddingIsCurrent,
  toMementoVector,
} from '@bike4mind/common';
import type { Principal } from '@bike4mind/memory';
import { createKeyProvider, decryptFact, decryptVector, encryptVector } from './factCipher';
import { EmbeddingFactory, getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/fab-pipeline';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';

/**
 * Re-embed a user's mementos into the current vector space (MEMENTO_EMBEDDING_MODEL) and stamp each
 * one with the model that produced it.
 *
 * This is the repair for every memento written before the model was pinned and recorded. Until it
 * runs, those mementos still EXIST and are still shown to the user, but the read paths refuse to
 * score them (their vector is from another model's space, where cosine is noise) - so they fall back
 * to lexical matching in V2 and are skipped entirely by V1's vector search. Memory is degraded, not
 * lost. This restores it.
 *
 * Idempotent: an already-current memento is skipped, so re-running costs nothing and a partial run
 * can simply be resumed - which is what makes `opts.limit` safe: stopping early leaves the rest
 * stale, and the next call picks them up with no cursor to carry. Embeds one memento at a time, tolerating a per-memento failure, because a
 * single provider error should not abandon a batch that is otherwise succeeding.
 */
/** The embedding service for the memento vector space, with the user's effective keys. */
async function createMementoEmbeddingService(userId: string) {
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });

  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  const { config, missing } = resolveEmbeddingConfig(provider, apiKeyTable);
  if (missing) {
    throw new Error(
      `${missing === 'openai' ? 'OpenAI' : missing === 'voyageai' ? 'VoyageAI' : 'Ollama'} ${
        missing === 'ollama' ? 'base URL' : 'API key'
      } required to re-embed memory, but none is available`
    );
  }

  return new EmbeddingFactory(config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
}

export async function reembedMementosForUser(
  userId: string,
  opts: { dryRun?: boolean; limit?: number } = {}
): Promise<{
  total: number;
  alreadyCurrent: number;
  reembedded: number;
  failed: number;
  skippedEmpty: number;
  stoppedAtLimit: boolean;
  errors: string[];
}> {
  const mementos = await Memento.find({ userId }).select('summary embedding embeddingModel');

  const stale = mementos.filter(m => !mementoEmbeddingIsCurrent(m));
  const stats = {
    total: mementos.length,
    alreadyCurrent: mementos.length - stale.length,
    reembedded: 0,
    failed: 0,
    skippedEmpty: 0,
    stoppedAtLimit: false,
    errors: [] as string[],
  };

  if (stale.length === 0 || opts.dryRun) return stats;

  const embeddingService = await createMementoEmbeddingService(userId);

  const limit = opts.limit ?? Infinity;

  for (const memento of stale) {
    // Spend the budget on PROVIDER CALLS, not on mementos examined: the blank-summary skip below
    // costs nothing, so letting it consume the allowance would let a user holding many of them burn
    // a whole request without repairing anything. `stoppedAtLimit` is reported rather than inferred
    // from `reembedded + failed === limit`, which cannot tell a page that stopped early from one
    // that happened to finish exactly on the boundary.
    if (stats.reembedded + stats.failed >= limit) {
      stats.stoppedAtLimit = true;
      break;
    }

    // The summary is what V1 embedded and what recall matches against; re-embedding anything else
    // would quietly change what the vector MEANS, not just which space it lives in.
    if (!memento.summary?.trim()) {
      stats.skippedEmpty += 1;
      continue;
    }

    try {
      const embedding = toMementoVector(await embeddingService.generateEmbedding(memento.summary));

      // Vector and stamp are written TOGETHER. Split across two writes, a crash between them leaves a
      // memento claiming a space its vector is not in - worse than the un-stamped state we started in,
      // because the read paths would then trust it.
      await Memento.updateOne({ _id: memento._id }, { $set: { embedding, embeddingModel: MEMENTO_EMBEDDING_ID } });
      stats.reembedded += 1;
    } catch (err) {
      // Leave it stale rather than half-written: it stays excluded from vector search, which is the
      // safe state, and the next run retries it. Recorded in errors (mirroring
      // migrateLedgerVectorsForPrincipal's own errors: string[]) so the caller can surface WHICH memento
      // needs attention instead of only a count.
      stats.failed += 1;
      const message = `memento ${String(memento._id)}: ${err instanceof Error ? err.message : String(err)}`;
      stats.errors.push(message);
      console.error(`[reembedMementos] user ${userId} ${message}`);
    }
  }

  return stats;
}

/**
 * Give one principal's LEDGER events a current-space vector: backfill events written without one, and
 * migrate ones left in an older space. Works for any principal kind; `ownerUserId` is the DEK owner,
 * whose effective keys pay for the embeds (matching the lake writers).
 *
 * Needed because the ledger vector is the ONLY copy for a belief V2 learned on its own (no V1 twin to
 * fall back on). Vectorless events are written by design when no provider key is available
 * (`createMementoEmbedder`); left that way they rank on lexical overlap for good.
 *
 * Rewriting in place is legitimate: the embedding is deliberately outside the chain hash, so the
 * tamper-evidence is untouched (see `rewriteEmbedding`, which also refuses shredded events).
 *
 * THREE PATHS, and the distinction between the last two is the whole point:
 *
 *   - NO vector: embed the fact. The backfill.
 *
 *   - the vector's source space is KNOWN (stamped as full-width text-embedding-3-small): a Matryoshka
 *     truncation is a valid pure projection of it. Free - no API call.
 *
 *   - the vector's source space is UNKNOWN (no stamp - written before the stamp existed, so it could be
 *     from ada-002 or anything else): it must be RE-EMBEDDED from the fact text. Truncating it would be
 *     the very bug this codebase keeps catching - an ada-002 vector sliced to 512 floats is not a
 *     512-dim text-embedding-3-small vector, it is noise wearing the right label, and stamping it
 *     current makes every read path trust it. Learned the hard way: the first cut of this migration
 *     did exactly that, and a real user's woodworking memory dropped out of its own recall.
 *
 * Idempotent: an event already in the current space is skipped. `limit` caps PROVIDER calls (embeds,
 * successful or not), never truncations; `stoppedAtLimit` says the principal has more to do. A dry run
 * makes no provider call and no write, and its counts mean "would".
 */
export async function migrateLedgerVectorsForPrincipal(
  target: { principal: Principal; ownerUserId: string },
  opts: { dryRun?: boolean; limit?: number } = {}
): Promise<{
  total: number;
  alreadyCurrent: number;
  truncated: number;
  reembedded: number;
  backfilled: number;
  noFact: number;
  failed: number;
  stoppedAtLimit: boolean;
  errors: string[];
}> {
  const { principal, ownerUserId } = target;
  const keys = createKeyProvider(memoryPrincipalKeyRepository);
  const dek = await keys.getDek(principal);

  const events = await memoryLedgerRepository.listChain(principal.kind, principal.id, ownerUserId);
  const stats = {
    total: events.length,
    alreadyCurrent: 0,
    truncated: 0,
    reembedded: 0,
    backfilled: 0,
    noFact: 0,
    failed: 0,
    stoppedAtLimit: false,
    errors: [] as string[],
  };

  // No key means the principal was crypto-shredded: there is nothing readable to migrate, and that is
  // the correct end state, not an error.
  if (!dek) return stats;

  const limit = opts.limit ?? Infinity;
  // Built on the first embed only, so a principal with no provider key still gets its free truncations.
  // undefined = not built yet, null = could not be built (no provider key).
  let service: Awaited<ReturnType<typeof createMementoEmbeddingService>> | null | undefined;

  for (const event of events) {
    if (event.shredded || event.kind === 'retract') continue;
    const tag = `event ${event.hash.slice(0, 12)}`;

    // Same read as toMemoryEvent (ledgerMemoryStore.ts): legacy plaintext, else the ciphered fact.
    const fact =
      event.factCipher && event.factIv && event.factTag
        ? decryptFact(dek, { cipher: event.factCipher, iv: event.factIv, tag: event.factTag })
        : event.fact;
    if (!fact?.trim()) {
      stats.noFact += 1;
      continue;
    }

    const hasVector = Boolean(event.embeddingCipher && event.embeddingIv && event.embeddingTag);
    if (hasVector && event.embeddingModel === MEMENTO_EMBEDDING_ID) {
      stats.alreadyCurrent += 1;
      continue;
    }

    try {
      let vector: number[] | null = null;
      if (hasVector && event.embeddingModel === MEMENTO_EMBEDDING_MODEL) {
        const full = decryptVector(dek, {
          cipher: event.embeddingCipher!,
          iv: event.embeddingIv!,
          tag: event.embeddingTag!,
        });
        if (full?.length) vector = toMementoVector(full);
      }

      const arm = vector ? 'truncated' : hasVector ? 'reembedded' : 'backfilled';
      if (!vector && stats.backfilled + stats.reembedded + stats.failed >= limit) {
        stats.stoppedAtLimit = true;
        break;
      }
      if (opts.dryRun) {
        stats[arm] += 1;
        continue;
      }
      if (!vector) {
        if (service === undefined) {
          try {
            service = await createMementoEmbeddingService(ownerUserId);
          } catch (err) {
            // Recorded once: a missing key would otherwise repeat the same message for every event.
            service = null;
            stats.errors.push(`owner ${ownerUserId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (!service) {
          stats.failed += 1;
          continue;
        }
        vector = toMementoVector(await service.generateEmbedding(fact));
      }

      const sealed = encryptVector(dek, vector);
      const modified = await memoryLedgerRepository.rewriteEmbedding(
        principal.kind,
        principal.id,
        ownerUserId,
        event.hash,
        { cipher: sealed.cipher, iv: sealed.iv, tag: sealed.tag, model: MEMENTO_EMBEDDING_ID }
      );
      if (modified === 0) {
        stats.failed += 1;
        stats.errors.push(`${tag}: no document matched the rewrite`);
        continue;
      }
      stats[arm] += 1;
    } catch (err) {
      stats.failed += 1;
      stats.errors.push(`${tag}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return stats;
}
