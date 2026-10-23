import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { mementoService } from '@bike4mind/services';

/**
 * Thin app-side wrapper around the core `embedMementoQuery` (`@bike4mind/services`): supplies this
 * app's concrete repositories as adapters. `recallMementosV2` and `recallLakeMemory` import from
 * here rather than the core package directly so the memento-space query-embed path stays in one
 * place regardless of which package a given recall path lives in.
 */
export async function embedMementoQuery(userId: string, query: string): Promise<{ vector: number[]; model: string }> {
  return mementoService.embedMementoQuery(userId, query, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
  });
}
