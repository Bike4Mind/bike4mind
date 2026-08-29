import { isObjectIdOrHexString } from 'mongoose';
import { IAdminSettingsRepository, IDataLakeRepository, IScopedSettingsRepository } from '@bike4mind/common';
import { scopedSettingsService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { shouldHaltConvergence, WorkOrigin } from '@server/queueHandlers/convergenceProvenance';

const SETTING_KEY = 'PauseLakeConvergence' as const;

export interface ConvergenceKillSwitchDeps {
  adminSettings: Pick<IAdminSettingsRepository, 'getSettingsValue' | 'findBySettingNames' | 'findAll'>;
  scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  dataLakes: Pick<IDataLakeRepository, 'findById'>;
}

/**
 * Resolve the effective pause flag for a unit of background work. Global work (no lakeId) reads the
 * platform switch; per-lake work folds the platform switch with any Lake-scope override (narrower
 * rung wins). NEVER throws - a read failure degrades to "not paused" and warns, matching the scoped
 * resolver's own degrade-to-default contract: failing a background sweep closed would silently
 * strand ingestion, and the work re-triggers on the next pass anyway. The warn is the diagnostic
 * that tells "switch was off" apart from "read failed" for a smoke test.
 */
async function resolvePauseFlag(
  lakeId: string | undefined,
  deps: ConvergenceKillSwitchDeps,
  logger?: Logger
): Promise<boolean> {
  try {
    // A STATIC registry lake's id is a human slug, not an ObjectId (see isFallbackLake), and
    // BaseModel.findById passes it straight to Mongoose - which raises a CastError, lands in the
    // catch below, and returns `false` WITHOUT ever reading the platform switch. So the whole kill
    // switch failed open for exactly the lake class "Rebuild passages" is deliberately kept open
    // for. Skipping the lookup instead falls through to the platform read, which is the correct
    // answer for a lake that has no document to carry a scoped override in the first place.
    // Guarded rather than caught, so a genuine lookup failure still reaches the catch.
    if (lakeId && isObjectIdOrHexString(lakeId)) {
      const lake = await deps.dataLakes.findById(lakeId);
      if (lake) {
        const { value } = await scopedSettingsService.resolveScopedSetting(
          SETTING_KEY,
          scopedSettingsService.scopeForLake(lake),
          { adminSettings: deps.adminSettings, scopedSettings: deps.scopedSettings },
          { logger }
        );
        return value === true;
      }
      // Lake deleted between enqueue and handling: fall back to the platform switch below.
    }
    return (await deps.adminSettings.getSettingsValue(SETTING_KEY)) === true;
  } catch (err) {
    logger?.warn?.('[convergenceKillSwitch] pause-flag read failed; treating as not paused', err);
    return false;
  }
}

/**
 * Whether this message's background work should be halted right now. Short-circuits user work before
 * any settings read, so a disabled or irrelevant switch does no I/O on the hot upload path ("gate
 * the work, not the use"). Callers log + return on `true`.
 */
export async function isConvergenceHalted(
  message: { origin?: WorkOrigin; lakeId?: string },
  deps: ConvergenceKillSwitchDeps,
  logger?: Logger
): Promise<boolean> {
  const origin = message.origin ?? 'user';
  if (origin !== 'convergence') return false;
  const paused = await resolvePauseFlag(message.lakeId, deps, logger);
  return shouldHaltConvergence(origin, paused);
}
