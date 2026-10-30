import {
  isShadowTier,
  settingsMap,
  type ICacheRepository,
  type IAdminSettingsRepository,
  type ModelInfo,
} from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

type TierUser = Parameters<typeof isShadowTier>[0];
type CounterCache = { cache: Pick<ICacheRepository, 'tryAddWithinLimitFixedWindow'> };

/** Outlives the UTC day it counts; the date in the key, not the TTL, starts each new day. */
const TOKEN_WINDOW_TTL_MS = 26 * 60 * 60 * 1000;
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * The substitute's ModelInfo for a restricted user whose requested text model is not allowlisted: the
 * first allowlisted enabled text model. Undefined when the request runs as asked (including when no
 * allowlisted model is available). Callers keep the requested id on client-visible fields.
 */
export function resolveShadowModelInfo(
  user: TierUser,
  requested: ModelInfo,
  models: ModelInfo[],
  allowlist: string[],
  logger?: Pick<Logger, 'warn'>
): ModelInfo | undefined {
  if (requested.type !== 'text' || !isShadowTier(user) || allowlist.includes(requested.id)) return undefined;
  const substitute = shadowCandidates(models, allowlist)[0];
  if (!substitute) {
    logger?.warn('[ModelRouting] no allowlisted model available; running the requested model', {
      requested: requested.id,
    });
  }
  return substitute;
}

/** The enabled allowlisted text models, in allowlist order: the substitute, then its silent fallbacks. */
export function shadowCandidates(models: ModelInfo[], allowlist: string[]): ModelInfo[] {
  const runnable = models.filter(m => m.type === 'text' && !m.disabled);
  return allowlist.flatMap(id => runnable.find(m => m.id === id) ?? []);
}

/** Usage-event fields naming a substituted model that actually ran; empty when it is the recorded one. */
export function executedModelFields(
  recorded: { id: string; backend: string },
  executed: { id: string; backend: string } | undefined
): { executedProvider?: string; executedModel?: string } {
  return executed && executed.id !== recorded.id
    ? { executedProvider: executed.backend, executedModel: executed.id }
    : {};
}

export type ShadowTierSettings = Awaited<ReturnType<typeof loadShadowTierSettings>>;

/** Restricted users only: their settings and the substitute model, if any. Others pay no I/O. */
export async function resolveShadowRouting({
  user,
  requested,
  models,
  adminSettings,
  logger,
}: {
  user: TierUser;
  requested: ModelInfo | undefined;
  models: ModelInfo[];
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
  logger?: Pick<Logger, 'warn'>;
}): Promise<{ settings: ShadowTierSettings | null; modelInfo: ModelInfo | undefined }> {
  if (!isShadowTier(user)) return { settings: null, modelInfo: undefined };
  const settings = await loadShadowTierSettings(adminSettings);
  const modelInfo = requested ? resolveShadowModelInfo(user, requested, models, settings.allowlist, logger) : undefined;
  return { settings, modelInfo };
}

/** Call only when `isShadowTier(user)`, so other users pay no settings read. */
export async function loadShadowTierSettings(
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>
): Promise<{ allowlist: string[]; dailyTokenCap: number; requestsPerMin: number }> {
  const map = await getSettingsMap(
    { adminSettings },
    { names: ['shadowTierModelAllowlist', 'shadowTierDailyTokenCap', 'shadowTierRequestsPerMin'] }
  );
  return {
    allowlist:
      getSettingsValue('shadowTierModelAllowlist', map) ?? settingsMap.shadowTierModelAllowlist.defaultValue ?? [],
    dailyTokenCap: Number(
      getSettingsValue('shadowTierDailyTokenCap', map) ?? settingsMap.shadowTierDailyTokenCap.defaultValue
    ),
    requestsPerMin: Number(
      getSettingsValue('shadowTierRequestsPerMin', map) ?? settingsMap.shadowTierRequestsPerMin.defaultValue
    ),
  };
}

export function shadowTokenKey(userId: string, now: Date): string {
  return `shadow-tokens:${userId}:${now.toISOString().slice(0, 10)}`;
}

/**
 * True when the request may start. Counts one token per request so a user at the cap is refused.
 * Actual usage is added after the run, so a request starting just under the cap can overshoot it by one request.
 */
export async function reserveShadowTokenBudget(
  user: TierUser & { id: string },
  cap: number,
  { cache }: CounterCache,
  now = new Date()
): Promise<boolean> {
  if (!isShadowTier(user)) return true;
  const { success } = await cache.tryAddWithinLimitFixedWindow(
    shadowTokenKey(user.id, now),
    1,
    cap,
    TOKEN_WINDOW_TTL_MS
  );
  return success;
}

/** Adds a finished request's input + output tokens to today's counter. Never throws. */
export async function recordShadowTokenUsage(
  user: TierUser & { id: string },
  tokens: number,
  { cache }: CounterCache,
  now = new Date()
): Promise<void> {
  if (!isShadowTier(user) || !(tokens > 0)) return;
  try {
    await cache.tryAddWithinLimitFixedWindow(shadowTokenKey(user.id, now), tokens, NO_LIMIT, TOKEN_WINDOW_TTL_MS);
  } catch (err) {
    Logger.globalInstance.warn('[ModelRouting] failed to record daily token usage', { userId: user.id, err });
  }
}
