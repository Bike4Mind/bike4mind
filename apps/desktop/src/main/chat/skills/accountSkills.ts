import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AxiosRequestConfig } from 'axios';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { RemoteSkillSource } from '@bike4mind/cli/skills';
import type { AuthState } from '@shared/auth';
import type { RemoteSkills } from './SkillCatalog';

/**
 * The two reads the account-skill provider needs, narrowed so a test can hand it a stub rather
 * than the whole AuthService, which builds a vault and an Electron-backed token store.
 */
export interface SkillsAuth {
  getApiClient(): AuthenticatedApiClient | null;
  getState(): AuthState;
}

/**
 * How long a session, a picker keystroke and the first turn of a conversation may wait on
 * `/api/skills`.
 *
 * The catalog is read by all three, and the desktop client's own timeout is 30s - long enough
 * that an unresponsive backend would stall each of them. Past this bound RemoteSkillSource
 * degrades to its cached snapshot, or to nothing; the next read is not blocked either way.
 */
const REMOTE_SKILLS_TIMEOUT_MS = 5_000;

/**
 * A stable, filename-safe id for one account on one backend. The desktop's remote-skill cache is
 * a file per key under userData, never the CLI's shared ~/.bike4mind/cache/remote-skills.json,
 * so neither another account nor another backend can read it.
 */
export function remoteSkillsKey(environmentUrl: string, userId: string): string {
  return createHash('sha256').update(`${environmentUrl}\u0000${userId}`).digest('hex').slice(0, 16);
}

/**
 * The signed-in account's skill source, or null when signed out.
 *
 * The cache is keyed per (backend, user) under userData and never the CLI's shared
 * `~/.bike4mind/cache/remote-skills.json`, so neither a sign-out nor an account switch can
 * surface the previous account's skills. The provider is read per catalog access, so both
 * changes take effect on the next one.
 *
 * The last source is kept only while the same account AND the same client are current: a
 * sign-out, an account switch or a re-auth that replaces the client all rebuild it. Rebuilding
 * per read instead would be correct but would construct a source on every turn, since
 * `SkillCatalog.revision` is read once per turn.
 */
export function accountSkillsProvider(auth: SkillsAuth, userData: string): RemoteSkills {
  let lastApi: AuthenticatedApiClient | null = null;
  let last: { key: string; source: RemoteSkillSource } | null = null;

  return () => {
    const api = auth.getApiClient();
    const { environment, user } = auth.getState();
    if (!api || !user?.id) {
      lastApi = null;
      last = null;
      return null;
    }

    const key = remoteSkillsKey(environment.url, user.id);
    if (last && lastApi === api && last.key === key) return last;

    lastApi = api;
    last = {
      key,
      source: new RemoteSkillSource(boundedClient(api), {
        cacheFilePath: join(userData, 'remote-skills', `${key}.json`),
        // Kept, and run wrapped as untrusted by expandSkill.
        includeImports: true,
      }),
    };
    return last;
  };
}

/** The client as RemoteSkillSource sees it, with the skills request bound to the timeout above. */
function boundedClient(api: AuthenticatedApiClient): Pick<AuthenticatedApiClient, 'get' | 'getCurrentUser'> {
  return {
    get: <T = unknown>(url: string, config?: AxiosRequestConfig) =>
      api.get<T>(url, { ...config, timeout: REMOTE_SKILLS_TIMEOUT_MS }),
    getCurrentUser: () => api.getCurrentUser(),
  };
}
