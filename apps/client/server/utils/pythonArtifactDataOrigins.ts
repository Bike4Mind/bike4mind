import { resolvePythonArtifactDataOrigins, type IAdminSettingsRepository } from '@bike4mind/common';
import { connectDB, adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { dataOriginReservedHosts } from '@bike4mind/services/llm/artifactGating';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'pythonArtifactDataOrigins' } });

// The sandbox shell must not hang on a slow database; past this it is served with no data origins.
const READ_TIMEOUT_MS = 3000;

/** Hosts a data origin may not name: this app's hosts and every other host on their sites. */
export function appReservedHosts(): string[] {
  return dataOriginReservedHosts();
}

/**
 * The `pythonArtifactDataOrigins` admin setting, validated, for `/api/pyodide-sandbox`.
 *
 * Fails closed: Artifacts turned off, an unreachable database, a slow read or an invalid stored
 * value all yield no origins, which is the sandbox CSP with no data origins. `degraded` is set
 * when the read itself failed, so the caller does not cache a response that may be missing origins.
 * Reads through the shared settings cache.
 */
export async function loadPythonArtifactDataOrigins(
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'> } = {
    adminSettings: adminSettingsRepository,
  }
): Promise<{ origins: string[]; degraded: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async () => {
      await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));
      const settings = await getSettingsMap(db);
      if (getSettingsValue('EnableArtifacts', settings) !== true) return [];
      return getSettingsValue('pythonArtifactDataOrigins', settings);
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${READ_TIMEOUT_MS} ms`)), READ_TIMEOUT_MS);
    });
    const stored = await Promise.race([read, timeout]);
    const origins = resolvePythonArtifactDataOrigins(stored, appReservedHosts());
    if (origins.length === 0 && Array.isArray(stored) && stored.length > 0) {
      logger.warn('[pyodide-sandbox] ignoring pythonArtifactDataOrigins: the stored list has an invalid entry');
    }
    return { origins, degraded: false };
  } catch (error) {
    logger.warn('[pyodide-sandbox] serving without data origins', { error });
    return { origins: [], degraded: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
