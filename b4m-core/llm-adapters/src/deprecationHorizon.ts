import { Logger } from '@bike4mind/observability';
import { IModelCatalogRow, ModelInfo } from '@bike4mind/common';
import { resolveCatalogRecords } from './mergeCatalog';

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

/** Lifecycle as a catalog row expresses it, narrowed off the lenient read shape. */
export interface CatalogLifecycle {
  status?: string;
  deprecationDate?: string;
  retirementDate?: string;
  replacedBy?: string;
}

const stringOr = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function narrowLifecycle(value: unknown): CatalogLifecycle | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const lifecycle = value as Record<string, unknown>;
  return {
    status: stringOr(lifecycle.status),
    deprecationDate: stringOr(lifecycle.deprecationDate),
    retirementDate: stringOr(lifecycle.retirementDate),
    replacedBy: stringOr(lifecycle.replacedBy),
  };
}

/**
 * Per-model lifecycle in force. Resolved through resolveCatalogRecords so this
 * view and the read path's merge agree on which row owns the lifecycle group,
 * and unlike getAvailableModels it survives the picker's deprecation filter -
 * which is what makes an EXPIRED view possible at all (sec 10).
 */
export function catalogLifecycles(rows: IModelCatalogRow[]): Map<string, CatalogLifecycle> {
  const lifecycles = new Map<string, CatalogLifecycle>();
  for (const [modelId, resolved] of resolveCatalogRecords(rows)) {
    const lifecycle = narrowLifecycle(resolved.record.lifecycle);
    if (lifecycle) lifecycles.set(modelId, lifecycle);
  }
  return lifecycles;
}

export interface ExpiredModel {
  modelId: string;
  status?: string;
  deprecationDate?: string;
  retirementDate?: string;
  /** Days past the earliest date it carries (negative); absent when only the status says so. */
  daysRemaining?: number;
}

const SUNSET_STATUSES: ReadonlySet<string> = new Set(['deprecated', 'retired']);

const daysUntil = (calendarDate: string, now: Date): number =>
  Math.ceil((new Date(calendarDate + 'T00:00:00Z').getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

/**
 * Models the catalog says are already gone: a sunset status, or a deprecation /
 * retirement date that has passed. Most overdue first; status-only entries last,
 * since there is no date to rank them by.
 */
export function getExpiredCatalogModels(
  lifecycles: ReadonlyMap<string, CatalogLifecycle>,
  now: Date = new Date()
): ExpiredModel[] {
  const expired: ExpiredModel[] = [];

  for (const [modelId, lifecycle] of lifecycles) {
    const dates = [lifecycle.deprecationDate, lifecycle.retirementDate].filter((d): d is string => !!d);
    const passed = dates.map(date => daysUntil(date, now)).filter(days => days <= 0);
    const byStatus = SUNSET_STATUSES.has(lifecycle.status ?? '');
    if (passed.length === 0 && !byStatus) continue;

    expired.push({
      modelId,
      status: lifecycle.status,
      deprecationDate: lifecycle.deprecationDate,
      retirementDate: lifecycle.retirementDate,
      daysRemaining: passed.length > 0 ? Math.min(...passed) : undefined,
    });
  }

  return expired.sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));
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
