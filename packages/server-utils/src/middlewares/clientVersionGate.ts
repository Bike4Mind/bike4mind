import {
  MinimumClientVersionsSchema,
  parseClientIdentity,
  requiredClientUpgrade,
  UpgradeRequiredError,
  type MinimumClientVersions,
  type SettingKey,
} from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

/**
 * The client-version gate every contract transport runs (CONVENTIONS.md section 9):
 * nextRouteForContract's prelude, defineLambdaRoute, and the completions route. The
 * published 426 (openapi/registerContract.ts) is only true while all three call this.
 */

const SETTING: SettingKey = 'minimumClientVersions';

// ms. Same short TTL as the other request-path settings readers (defaultWriteRateLimit.ts).
const SETTINGS_CACHE_TTL_MS = 15_000;
let settingsCache: { value: MinimumClientVersions; expiresAt: number } | undefined;

type GateLogger = { warn(message: string, meta?: Record<string, unknown>): void };
type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Test-only: drop the in-process settings cache between cases. */
export const __resetClientVersionGateCache = (): void => {
  settingsCache = undefined;
};

async function readMinimums(logger: GateLogger | undefined): Promise<MinimumClientVersions> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) return settingsCache.value;
  // Fail open: the gate is a compatibility signal, and blocking every declared client on a
  // settings outage would be worse than serving an outdated one for a few seconds.
  let value: MinimumClientVersions = {};
  try {
    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { skipCache: true, names: [SETTING] }
    );
    // Re-parsed here: getSettingsValue substitutes the coded default on a bad row, but the
    // type it returns is the preprocessed schema's, so narrow it to the map shape explicitly.
    const parsed = MinimumClientVersionsSchema.safeParse(getSettingsValue(SETTING, settings));
    if (parsed.success) value = parsed.data;
  } catch (error) {
    // Cached below, so an outage costs one failed read (and one line) per TTL.
    logger?.warn('[clientVersionGate] settings unavailable; not gating client versions', { error });
  }
  settingsCache = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
  return value;
}

/**
 * The 426 to answer with when the request declares a client build below the configured
 * minimum, else undefined. A request that does not declare itself never reads the setting.
 * `headers` must have lowercase keys (Node and Lambda Function URL events both do).
 */
export async function checkClientVersion(
  headers: HeaderBag,
  logger?: GateLogger
): Promise<UpgradeRequiredError | undefined> {
  const client = parseClientIdentity(headers);
  if (!client) return undefined;
  const minimumVersion = requiredClientUpgrade(client, await readMinimums(logger));
  return minimumVersion ? new UpgradeRequiredError(client.name, client.version, minimumVersion) : undefined;
}
