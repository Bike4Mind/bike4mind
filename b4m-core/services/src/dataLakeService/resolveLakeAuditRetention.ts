import {
  IAdminSettingsRepository,
  resolveLakeAccessAuditRetentionDays,
  resolveLakeAccessQueryTextRetentionDays,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

export interface LakeAuditRetention {
  auditRetentionDays: number;
  queryTextRetentionDays: number;
}

/**
 * Read the platform-configured lake access audit retention, already floor/ceiling-clamped.
 * Shape mirrors `resolveSearchBudgets`: uses the cached settings accessor, and never throws - a
 * settings outage falls back to the defaults (which already sit at the floor) rather than
 * blocking the write path that calls this.
 */
export async function resolveLakeAuditRetention(
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'> },
  options?: { logger?: Logger; skipCache?: boolean }
): Promise<LakeAuditRetention> {
  const logger = options?.logger;
  try {
    const values = await getSettingsByNames(['LakeAccessAuditRetentionDays', 'LakeAccessQueryTextRetentionDays'], db, {
      logger,
      skipCache: options?.skipCache,
    });
    const auditRetentionDays = resolveLakeAccessAuditRetentionDays(unwrapNumber(values.LakeAccessAuditRetentionDays));
    const queryTextRetentionDays = resolveLakeAccessQueryTextRetentionDays(
      unwrapNumber(values.LakeAccessQueryTextRetentionDays),
      auditRetentionDays
    );
    return { auditRetentionDays, queryTextRetentionDays };
  } catch (err) {
    logger?.warn?.('[lakeAccessAudit] could not read retention settings; using floor defaults', err);
    const auditRetentionDays = resolveLakeAccessAuditRetentionDays(undefined);
    return {
      auditRetentionDays,
      queryTextRetentionDays: resolveLakeAccessQueryTextRetentionDays(undefined, auditRetentionDays),
    };
  }
}

function unwrapNumber(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  return Number(raw);
}
