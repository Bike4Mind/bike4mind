import { apiKeyRepository, adminSettingsRepository, Memento } from '@bike4mind/database';
import { MEMENTO_EMBEDDING_MODEL, mementoEmbeddingIsCurrent } from '@bike4mind/common';
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

  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });

  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  const config: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
  if (provider === 'openai') {
    if (!apiKeyTable?.openai) throw new Error('OpenAI API key required to re-embed mementos, but none is available');
    config.openaiApiKey = apiKeyTable.openai;
  } else if (provider === 'voyageai') {
    if (!apiKeyTable?.voyageai) throw new Error('VoyageAI API key required to re-embed mementos, but none is available');
    config.voyageApiKey = apiKeyTable.voyageai;
  }

  const embeddingService = new EmbeddingFactory(config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);

  for (const memento of stale) {
    // The summary is what V1 embedded and what recall matches against; re-embedding anything else
    // would quietly change what the vector MEANS, not just which space it lives in.
    if (!memento.summary?.trim()) {
      stats.skippedEmpty += 1;
      continue;
    }

    try {
      const embedding = await embeddingService.generateEmbedding(memento.summary);

      // Vector and stamp are written TOGETHER. Split across two writes, a crash between them leaves a
      // memento claiming a space its vector is not in - worse than the un-stamped state we started in,
      // because the read paths would then trust it.
      await Memento.updateOne(
        { _id: memento._id },
        { $set: { embedding, embeddingModel: MEMENTO_EMBEDDING_MODEL } }
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
