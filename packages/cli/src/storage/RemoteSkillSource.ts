import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { CustomCommand } from './types.js';
import { isReservedCommandName } from '../config/commands.js';

/**
 * Fetches skills authored on B4M web (`/api/skills`) and adapts them to the
 * `CustomCommand` shape that `CustomCommandStore` already understands. Local
 * files take precedence on name collision - the store loads remote first and
 * lets later (local) entries overwrite via the existing map-replacement.
 *
 * Offline behavior: every successful fetch is snapshotted to
 * `~/.bike4mind/cache/remote-skills.json`. On network failure (and within the
 * TTL window) the cache is used so the CLI keeps working without a connection.
 */

/** Server-side skill document shape returned by `GET /api/skills`. */
interface RemoteSkillDocument {
  id: string;
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  /** Owning user. A foreign value means the skill is only visible via
   *  `isGlobalRead` (cross-account) and must not be registered locally. */
  userId?: string;
  /** Set on a Skill Market import: owned by the user but authored by someone else. */
  importedFrom?: { listingId: string };
}

interface RemoteSkillListResponse {
  data: RemoteSkillDocument[];
  hasMore?: boolean;
  total?: number;
}

interface RemoteSkillCacheFile {
  /** ISO timestamp of when the cache was written. */
  fetchedAt: string;
  /** Skills as last seen on the server. */
  skills: RemoteSkillDocument[];
}

export interface RemoteSkillSourceOptions {
  /** Override the cache file path - primarily for tests. Defaults to `~/.bike4mind/cache/remote-skills.json`. */
  cacheFilePath?: string;
  /** Soft cache TTL in milliseconds. Within this window the cached snapshot is
   *  returned without a network call. Defaults to 5 minutes. */
  freshTtlMs?: number;
  /** Hard limit on entries fetched per call. */
  pageLimit?: number;
  /** Keep Skill Market imports, marked `untrusted`, instead of dropping them. Only for a host that
   *  runs an untrusted command wrapped as untrusted content (apps/desktop's expandSkill). */
  includeImports?: boolean;
}

const DEFAULT_FRESH_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 100;

export class RemoteSkillSource {
  private readonly cacheFilePath: string;
  private readonly freshTtlMs: number;
  private readonly pageLimit: number;
  private readonly includeImports: boolean;
  private forceNext = false;

  constructor(
    private readonly apiClient: Pick<AuthenticatedApiClient, 'get' | 'getCurrentUser'>,
    options: RemoteSkillSourceOptions = {}
  ) {
    this.cacheFilePath = options.cacheFilePath ?? path.join(os.homedir(), '.bike4mind', 'cache', 'remote-skills.json');
    this.freshTtlMs = options.freshTtlMs ?? DEFAULT_FRESH_TTL_MS;
    this.pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.includeImports = options.includeImports ?? false;
  }

  /** Make the next `fetchSkills` go to the network even inside the TTL. The cache stays as the
   *  offline fallback. For a host that just changed the account's skills itself. */
  invalidate(): void {
    this.forceNext = true;
  }

  /**
   * Returns the user's remote skills mapped to `CustomCommand`. Uses an
   * in-memory + on-disk cache to avoid a network round-trip on every
   * `/commands` invocation and to keep working offline.
   */
  async fetchSkills(): Promise<CustomCommand[]> {
    const cached = await this.readCache();
    const forced = this.forceNext;
    this.forceNext = false;
    if (cached && !forced && this.isFresh(cached)) {
      return this.mapAndFilter(cached.skills);
    }

    try {
      const response = await this.apiClient.get<RemoteSkillListResponse>(`/api/skills?limit=${this.pageLimit}`);
      const skills = response?.data ?? [];
      // Empty-response cache-poison guard: a 200 with `data: []` during a
      // transient backend regression would otherwise overwrite a valid cached
      // snapshot with nothing, breaking offline fallback for the TTL window.
      // Only persist when there's actual content, or when the cache is also
      // empty/absent (initial-state and genuinely-empty users still work).
      const shouldWrite = skills.length > 0 || !cached || cached.skills.length === 0;
      if (shouldWrite) {
        await this.writeCache({ fetchedAt: new Date().toISOString(), skills });
      }
      return this.mapAndFilter(skills);
    } catch (error) {
      // Network / auth failure - degrade gracefully to the cache if we have one.
      // The CLI is expected to keep working offline; surface the error in debug
      // logs only so a transient outage doesn't break `/commands`.
      if (process.env.BIKE4MIND_CLI_DEBUG) {
        console.warn(
          '[RemoteSkillSource] fetch failed, falling back to cache:',
          error instanceof Error ? error.message : String(error)
        );
      }
      if (cached) {
        return this.mapAndFilter(cached.skills);
      }
      return [];
    }
  }

  /**
   * Map server skills to `CustomCommand`, dropping any that must not register:
   * - a name that shadows a built-in OR a first-party feature slash command
   *   (tavern/quest/hearth), which would otherwise hijack the command, and
   * - a foreign-owned skill (a `userId` other than the current user's), which is
   *   only visible cross-account via `isGlobalRead`, and
   * - a Skill Market import: the user owns the copy but someone else wrote it, and local commands run
   *   as trusted instructions next to shell/file tools (the web app wraps it as untrusted instead).
   *   With `includeImports` it is kept as `untrusted: true`, for a host that wraps it the same way.
   * Own, system (no `userId`), and org-scoped (server-gated, no `userId`) skills pass.
   *
   * Unauthenticated contract (fail-closed, intentional): when getCurrentUser()
   * returns null, currentUserId is undefined and every skill carrying a userId -
   * including the user's OWN - is dropped. This over-restricts rather than risk
   * registering a foreign skill against an unverifiable identity; own skills
   * reappear once authenticated.
   */
  private async mapAndFilter(skills: RemoteSkillDocument[]): Promise<CustomCommand[]> {
    const currentUserId = (await this.apiClient.getCurrentUser?.())?.id;
    return skills
      .filter(skill => {
        if (isReservedCommandName(skill.name)) return false;
        if (skill.userId && skill.userId !== currentUserId) return false;
        if (skill.importedFrom && !this.includeImports) return false;
        return true;
      })
      .map(skill => this.toCustomCommand(skill));
  }

  /** For tests and the `/commands:reload` handler - clears the on-disk cache. */
  async clearCache(): Promise<void> {
    try {
      await fs.unlink(this.cacheFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private isFresh(cache: RemoteSkillCacheFile): boolean {
    const fetchedAt = Date.parse(cache.fetchedAt);
    if (Number.isNaN(fetchedAt)) return false;
    return Date.now() - fetchedAt < this.freshTtlMs;
  }

  private async readCache(): Promise<RemoteSkillCacheFile | null> {
    try {
      const raw = await fs.readFile(this.cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'fetchedAt' in parsed &&
        'skills' in parsed &&
        Array.isArray((parsed as RemoteSkillCacheFile).skills)
      ) {
        return parsed as RemoteSkillCacheFile;
      }
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Corrupt cache file - log and treat as missing so we re-fetch.
      if (process.env.BIKE4MIND_CLI_DEBUG) {
        console.warn('[RemoteSkillSource] cache read failed:', error instanceof Error ? error.message : String(error));
      }
      return null;
    }
  }

  private async writeCache(snapshot: RemoteSkillCacheFile): Promise<void> {
    try {
      // Skill bodies are user prompt material - restrict cache visibility to
      // the owning user. Mode 0o700 on the directory, 0o600 on the file mirror
      // the access-token cache pattern under `~/.bike4mind/`.
      await fs.mkdir(path.dirname(this.cacheFilePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.cacheFilePath, JSON.stringify(snapshot, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (error) {
      // Cache writes are best-effort - a write failure shouldn't break `/commands`.
      if (process.env.BIKE4MIND_CLI_DEBUG) {
        console.warn('[RemoteSkillSource] cache write failed:', error instanceof Error ? error.message : String(error));
      }
    }
  }

  private toCustomCommand(skill: RemoteSkillDocument): CustomCommand {
    return {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      argumentHint: skill.argumentHint,
      allowedTools: skill.allowedTools,
      disableModelInvocation: skill.disableModelInvocation,
      ...(skill.importedFrom ? { untrusted: true } : {}),
      source: 'remote',
      // Synthetic - remote skills have no on-disk path. Used in `/commands`
      // listings to disambiguate the origin; never opened by the file loader.
      filePath: `b4m:/api/skills/${skill.id}`,
    };
  }
}
