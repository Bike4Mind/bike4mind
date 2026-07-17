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
import { createKeyProvider, decryptFact, decryptVector, encryptVector } from './factCipher';
import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
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
 * can simply be resumed. Embeds one memento at a time, tolerating a per-memento failure, because a
 * single provider error should not abandon a batch that is otherwise succeeding.
 */
/** The embedding service for the memento vector space, with the user's effective keys. */
async function createMementoEmbeddingService(userId: string) {
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });

  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  const config: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
  if (provider === 'openai') {
    if (!apiKeyTable?.openai) throw new Error('OpenAI API key required to re-embed memory, but none is available');
    config.openaiApiKey = apiKeyTable.openai;
  } else if (provider === 'voyageai') {
    if (!apiKeyTable?.voyageai) throw new Error('VoyageAI API key required to re-embed memory, but none is available');
    config.voyageApiKey = apiKeyTable.voyageai;
  }

  return new EmbeddingFactory(config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
}

export async function reembedMementosForUser(
  userId: string,
  opts: { dryRun?: boolean } = {}
): Promise<{ total: number; alreadyCurrent: number; reembedded: number; failed: number; skippedEmpty: number }> {
  const mementos = await Memento.find({ userId }).select('summary embedding embeddingModel');

  const stale = mementos.filter(m => !mementoEmbeddingIsCurrent(m));
  const stats = {
    total: mementos.length,
    alreadyCurrent: mementos.length - stale.length,
    reembedded: 0,
    failed: 0,
    skippedEmpty: 0,
  };

  if (stale.length === 0 || opts.dryRun) return stats;

  const embeddingService = await createMementoEmbeddingService(userId);

  for (const memento of stale) {
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
      await Memento.updateOne(
        { _id: memento._id },
        { $set: { embedding, embeddingModel: MEMENTO_EMBEDDING_ID } }
      );
      stats.reembedded += 1;
    } catch (err) {
      // Leave it stale rather than half-written: it stays excluded from vector search, which is the
      // safe state, and the next run retries it.
      stats.failed += 1;
      console.error(
        `[reembedMementos] user ${userId} memento ${String(memento._id)} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return stats;
}


/**
 * Migrate a user's LEDGER vectors into the current space.
 *
 * Needed because the ledger cannot be re-embedded the way a memento can - it is append-only, and its
 * vector is the ONLY copy for a belief V2 learned on its own (no V1 twin exists to fall back on). If
 * they are left in the old space the space-id gate correctly refuses them and that memory goes quiet.
 *
 * Rewriting them in place is legitimate: the embedding is deliberately outside the chain hash, so the
 * tamper-evidence is untouched (see `rewriteEmbedding`).
 *
 * TWO PATHS, and the distinction is the whole point:
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
 * Idempotent: an event already in the current space is skipped.
 */
export async function migrateLedgerVectorsForUser(
  userId: string
): Promise<{
  total: number;
  alreadyCurrent: number;
  truncated: number;
  reembedded: number;
  noVector: number;
  failed: number;
  errors: string[];
}> {
  const keys = createKeyProvider(memoryPrincipalKeyRepository);
  const dek = await keys.getDek({ kind: 'user', id: userId });

  const events = await memoryLedgerRepository.listChain('user', userId, userId);
  const stats = {
    total: events.length,
    alreadyCurrent: 0,
    truncated: 0,
    reembedded: 0,
    noVector: 0,
    failed: 0,
    errors: [] as string[],
  };

  // No key means the principal was crypto-shredded: there is nothing readable to migrate, and that is
  // the correct end state, not an error.
  if (!dek) return stats;

  const embeddingService = await createMementoEmbeddingService(userId);

  for (const event of events) {
    if (!event.embeddingCipher || !event.embeddingIv || !event.embeddingTag) {
      stats.noVector += 1;
      continue;
    }
    if (event.embeddingModel === MEMENTO_EMBEDDING_ID) {
      stats.alreadyCurrent += 1;
      continue;
    }

    try {
      let vector: number[] | null = null;
      let viaTruncation = false;

      if (event.embeddingModel === MEMENTO_EMBEDDING_MODEL) {
        // Known: full-width vector from the current model. Truncation is a valid projection of it.
        const full = decryptVector(dek, {
          cipher: event.embeddingCipher,
          iv: event.embeddingIv,
          tag: event.embeddingTag,
        });
        if (full?.length) {
          vector = toMementoVector(full);
          viaTruncation = true;
        }
      }

      if (!vector) {
        // Unknown provenance - the only honest move is to recompute the vector from the fact itself.
        const fact = decryptFact(dek, {
          cipher: event.factCipher!,
          iv: event.factIv!,
          tag: event.factTag!,
        });
        if (!fact?.trim()) {
          stats.failed += 1;
          stats.errors.push(`event ${event.hash.slice(0, 12)}: no readable fact to re-embed from`);
          continue;
        }
        vector = toMementoVector(await embeddingService.generateEmbedding(fact));
      }

      const sealed = encryptVector(dek, vector);
      const modified = await memoryLedgerRepository.rewriteEmbedding('user', userId, userId, event.hash, {
        cipher: sealed.cipher,
        iv: sealed.iv,
        tag: sealed.tag,
        model: MEMENTO_EMBEDDING_ID,
      });
      if (modified === 0) {
        stats.failed += 1;
        stats.errors.push(`event ${event.hash.slice(0, 12)}: no document matched the rewrite`);
        continue;
      }

      if (viaTruncation) stats.truncated += 1;
      else stats.reembedded += 1;
    } catch (err) {
      stats.failed += 1;
      stats.errors.push(`event ${event.hash.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return stats;
}
