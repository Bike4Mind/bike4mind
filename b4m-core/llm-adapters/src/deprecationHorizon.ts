import { Logger } from '@bike4mind/observability';
import { ModelInfo } from '@bike4mind/common';

export interface ExpiringModel {
  modelId: string;
  name: string;
  deprecationDate: string;
  daysRemaining: number;
}

/**
 * Scans model definitions for models expiring within N days of today.
 * Returns models that are either already expired (negative daysRemaining)
 * or expiring within the specified horizon.
 */
export function getExpiringModels(models: ModelInfo[], daysAhead: number): ExpiringModel[] {
  const now = new Date();
  const results: ExpiringModel[] = [];

  for (const model of models) {
    if (!model.deprecationDate) continue;

    const cutoff = new Date(model.deprecationDate + 'T00:00:00Z');
    const diffMs = cutoff.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (daysRemaining <= daysAhead) {
      results.push({
        modelId: model.id,
        name: model.name,
        deprecationDate: model.deprecationDate,
        daysRemaining,
      });
    }
  }

  return results.sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/**
 * Logs a warning for any models expiring within the given horizon.
 * Intended to be called at server startup.
 */
export function logExpiringModels(models: ModelInfo[], daysAhead = 30): void {
  const expiring = getExpiringModels(models, daysAhead);
  if (expiring.length === 0) return;

  for (const m of expiring) {
    if (m.daysRemaining <= 0) {
      Logger.globalInstance.warn(
        `[model-sunset] EXPIRED: ${m.name} (${m.modelId}) expired ${Math.abs(m.daysRemaining)} days ago (${m.deprecationDate})`
      );
    } else {
      Logger.globalInstance.warn(
        `[model-sunset] EXPIRING SOON: ${m.name} (${m.modelId}) expires in ${m.daysRemaining} days (${m.deprecationDate})`
      );
    }
  }
}
