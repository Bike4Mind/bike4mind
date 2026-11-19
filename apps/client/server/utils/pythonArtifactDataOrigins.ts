import {
  pythonDataOriginReservedHosts,
  resolvePythonArtifactDataOrigins,
  type IAdminSettingsRepository,
} from '@bike4mind/common';
import { connectDB, adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { Config } from '@bike4mind/server-utils/utils/config';

// The sandbox shell must not hang on a slow database; past this it is served with no data origins.
const READ_TIMEOUT_MS = 3000;

/** Hosts a data origin may not name: this app's host and every other host on its site. */
export function appReservedHosts(): string[] {
  return pythonDataOriginReservedHosts([process.env.APP_URL], host => registrableDomain(host));
}

/**
 * The `pythonArtifactDataOrigins` admin setting, validated, for `/api/pyodide-sandbox`.
 *
 * Fails closed: an unreachable database, a slow read or an invalid stored value all yield `[]`,
 * which is the sandbox CSP with no data origins. Reads through the shared settings cache.
 */
export async function loadPythonArtifactDataOrigins(
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'> } = {
    adminSettings: adminSettingsRepository,
  }
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async () => {
      await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));
      const settings = await getSettingsMap(db);
      return getSettingsValue('pythonArtifactDataOrigins', settings);
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${READ_TIMEOUT_MS} ms`)), READ_TIMEOUT_MS);
    });
    const stored = await Promise.race([read, timeout]);
    const origins = resolvePythonArtifactDataOrigins(stored, appReservedHosts());
    if (origins.length === 0 && Array.isArray(stored) && stored.length > 0) {
      console.warn('[pyodide-sandbox] ignoring pythonArtifactDataOrigins: the stored list has an invalid entry');
    }
    return origins;
  } catch (error) {
    console.warn(
      `[pyodide-sandbox] serving without data origins: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
