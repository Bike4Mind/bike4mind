import { IAdminSettingsRepository, resolveLakeConfigAuditRetentionDays } from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';

/**
 * The minimal logger the lake services thread (`req.logger` at the routes). `warn` is OPTIONAL so
 * this accepts BOTH house adapter flavors - the required-`warn` shape (transferLakeOwnership,
 * archiveDataLake) and the optional-method shape (`{ warn?: ... }`, used by the fabFileService tag
 * doors) - without forcing a cast at either kind of call site. A full `Logger` satisfies it too.
 * The consumer falls back to `console.warn`, so an absent method still cannot go silent.
 */
export type LakeConfigAuditLogger = { warn?: (msg: string, ...args: unknown[]) => void };

/**
 * Read the platform-configured lake CONFIG-audit retention, already floor/ceiling-clamped.
 *
 * A twin of `resolveLakeAuditRetention` rather than a third value returned from it: that resolver
 * serves the RETRIEVAL path and pairs the audit window with the query-text window, and a config
 * write has no query text and no reason to read a setting it does not use. Same contract - the
 * cached settings accessor, and never throws, since a settings outage must not block the config
 * write this audits (the fallback already sits at the floor).
 *
 * The clamp here is a convenience for the caller, not the guarantee: `record()` re-resolves it
 * inside the repository, so a caller that skips this entirely still cannot store an unclamped
 * value.
 */
export async function resolveLakeConfigAuditRetention(
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'> },
  options?: { logger?: LakeConfigAuditLogger; skipCache?: boolean }
): Promise<number> {
  const logger = options?.logger;
  try {
    // No logger threaded down: `getSettingsByNames` takes the concrete `Logger` class, which the
    // minimal shape above deliberately is not. Its own logging is a nice-to-have; the catch below
    // is what actually reports a settings outage on this path.
    const values = await getSettingsByNames(['LakeConfigAuditRetentionDays'], db, {
      skipCache: options?.skipCache,
    });
    return resolveLakeConfigAuditRetentionDays(unwrapNumber(values.LakeConfigAuditRetentionDays));
  } catch (err) {
    logger?.warn?.('[lakeConfigAudit] could not read retention setting; using floor default', err);
    return resolveLakeConfigAuditRetentionDays(undefined);
  }
}

function unwrapNumber(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  return Number(raw);
}
