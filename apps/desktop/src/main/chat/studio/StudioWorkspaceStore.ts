import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  studioAssetSchema,
  studioIdSchema,
  studioJobSchema,
  type StudioAsset,
  type StudioJob,
  type StudioWorkspace,
} from '@shared/studio';
import type { SessionStore } from '../SessionStore';
import { assertScopeKey } from '../sessionScope';

type StudioSessions = Pick<SessionStore, 'scopeKey' | 'resolveStudioWorkspace' | 'withStudioSession'>;

export interface StudioPageOptions {
  limit?: number;
  cursor?: string;
}

export interface StudioPage<T> {
  items: T[];
  nextCursor?: string;
}

export class StudioWorkspaceStore {
  constructor(
    private readonly baseDirectory: string,
    private readonly sessions: StudioSessions
  ) {}

  async get(sessionId: string): Promise<StudioWorkspace | null> {
    const scope = this.sessions.scopeKey();
    const workspace = await this.locate(sessionId, scope);
    if (!workspace) return null;
    const [assets, jobs] = await Promise.all([
      this.records(workspace.directory, 'assets', studioAssetSchema, {}),
      this.records(workspace.directory, 'jobs', studioJobSchema, {}),
    ]);
    if (this.sessions.scopeKey() !== scope) return null;
    return {
      ...workspace.identity,
      assets: assets.items,
      jobs: jobs.items,
      ...(assets.nextCursor ? { nextAssetCursor: assets.nextCursor } : {}),
      ...(jobs.nextCursor ? { nextJobCursor: jobs.nextCursor } : {}),
    };
  }

  async listAssets(sessionId: string, options: StudioPageOptions = {}): Promise<StudioPage<StudioAsset> | null> {
    const scope = this.sessions.scopeKey();
    const workspace = await this.locate(sessionId, scope);
    if (!workspace) return null;
    const page = await this.records(workspace.directory, 'assets', studioAssetSchema, options);
    return this.sessions.scopeKey() === scope ? page : null;
  }

  async listJobs(sessionId: string, options: StudioPageOptions = {}): Promise<StudioPage<StudioJob> | null> {
    const scope = this.sessions.scopeKey();
    const workspace = await this.locate(sessionId, scope);
    if (!workspace) return null;
    const page = await this.records(workspace.directory, 'jobs', studioJobSchema, options);
    return this.sessions.scopeKey() === scope ? page : null;
  }

  upsertAsset(sessionId: string, asset: StudioAsset, expectedScope = this.sessions.scopeKey()): Promise<boolean> {
    return this.put(sessionId, 'assets', studioAssetSchema.parse(asset), expectedScope);
  }

  upsertJob(sessionId: string, job: StudioJob, expectedScope = this.sessions.scopeKey()): Promise<boolean> {
    return this.put(sessionId, 'jobs', studioJobSchema.parse(job), expectedScope);
  }

  getJob(sessionId: string, id: string): Promise<StudioJob | null> {
    return this.record(sessionId, 'jobs', id, studioJobSchema);
  }

  getAsset(sessionId: string, id: string): Promise<StudioAsset | null> {
    return this.record(sessionId, 'assets', id, studioAssetSchema);
  }

  async pruneOrphans(
    activeWorkspaceIds: ReadonlySet<string>,
    removeMedia: (workspaceId: string, assetId: string) => Promise<void>
  ): Promise<void> {
    const scope = this.sessions.scopeKey();
    if (!scope) return;
    const directory = join(this.baseDirectory, assertScopeKey(scope));
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const id of names) {
      if (!studioIdSchema.safeParse(id).success || this.sessions.scopeKey() !== scope) continue;
      const folder = join(directory, id);
      const marker = join(folder, '.orphaned-at');
      if (activeWorkspaceIds.has(id)) {
        await rm(marker, { force: true });
        continue;
      }
      const recorded = await readFile(marker, 'utf8').catch(() => '');
      if (!recorded) {
        await writeFile(marker, String(Date.now()), { flag: 'wx' }).catch(() => undefined);
        continue;
      }
      const since = Number(recorded);
      if (!Number.isFinite(since) || Date.now() - since < 30 * 24 * 60 * 60_000) continue;
      let cursor: string | undefined;
      do {
        const page = await this.records(folder, 'assets', studioAssetSchema, { cursor });
        for (const asset of page.items) {
          if (this.sessions.scopeKey() !== scope) return;
          await removeMedia(id, asset.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
      if (this.sessions.scopeKey() !== scope) return;
      await rm(folder, { recursive: true, force: true });
    }
  }

  private async record<T>(sessionId: string, collection: string, id: string, schema: z.ZodType<T>): Promise<T | null> {
    studioIdSchema.parse(id);
    const scope = this.sessions.scopeKey();
    const workspace = await this.locate(sessionId, scope);
    if (!workspace) return null;
    try {
      const record = schema.parse(
        JSON.parse(await readFile(join(workspace.directory, collection, `${id}.json`), 'utf8'))
      );
      return this.sessions.scopeKey() === scope ? record : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async removeAsset(sessionId: string, assetId: string, expectedScope = this.sessions.scopeKey()): Promise<boolean> {
    studioIdSchema.parse(assetId);
    return (
      (await this.sessions.withStudioSession(sessionId, expectedScope, async () => {
        const workspace = await this.locate(sessionId, expectedScope);
        if (!workspace || this.sessions.scopeKey() !== expectedScope) return false;
        await rm(join(workspace.directory, 'assets', `${assetId}.json`), { force: true });
        return true;
      })) ?? false
    );
  }

  private async locate(sessionId: string, scope: string | null) {
    if (!scope || this.sessions.scopeKey() !== scope) return null;
    const identity = await this.sessions.resolveStudioWorkspace(sessionId, scope);
    if (!identity || this.sessions.scopeKey() !== scope) return null;
    studioIdSchema.parse(identity.workspaceId);
    return { identity, directory: join(this.baseDirectory, assertScopeKey(scope), identity.workspaceId) };
  }

  private async put(
    sessionId: string,
    collection: 'assets' | 'jobs',
    record: StudioAsset | StudioJob,
    scope: string | null
  ): Promise<boolean> {
    return (
      (await this.sessions.withStudioSession(sessionId, scope, async () => {
        const workspace = await this.locate(sessionId, scope);
        if (!workspace) return false;
        const owner = await this.sessions.resolveStudioWorkspace(record.originatingSessionId, scope);
        if (owner?.workspaceId !== workspace.identity.workspaceId) {
          const schema = collection === 'assets' ? studioAssetSchema : studioJobSchema;
          const existing = await readFile(join(workspace.directory, collection, `${record.id}.json`), 'utf8')
            .then(text => schema.parse(JSON.parse(text)))
            .catch(() => null);
          const jobId = 'jobId' in record ? record.jobId : undefined;
          const job = jobId
            ? await readFile(join(workspace.directory, 'jobs', `${studioIdSchema.parse(jobId)}.json`), 'utf8')
                .then(text => studioJobSchema.parse(JSON.parse(text)))
                .catch(() => null)
            : null;
          if (
            existing?.originatingSessionId !== record.originatingSessionId &&
            job?.originatingSessionId !== record.originatingSessionId
          )
            return false;
        }
        const directory = join(workspace.directory, collection);
        await mkdir(directory, { recursive: true });
        const temporary = join(directory, `${record.id}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(record), 'utf8');
          if (this.sessions.scopeKey() !== scope) return false;
          await rename(temporary, join(directory, `${record.id}.json`));
          return true;
        } finally {
          await rm(temporary, { force: true });
        }
      })) ?? false
    );
  }

  private async records<T>(
    directory: string,
    collection: string,
    schema: z.ZodType<T>,
    options: StudioPageOptions
  ): Promise<StudioPage<T>> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Studio page limit must be 1-100');
    if (options.cursor !== undefined) studioIdSchema.parse(options.cursor);
    const folder = join(directory, collection);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [] };
      throw error;
    }
    const ids = names
      .filter(name => name.endsWith('.json') && studioIdSchema.safeParse(name.slice(0, -5)).success)
      .map(name => name.slice(0, -5))
      .sort()
      .filter(id => !options.cursor || id > options.cursor);
    const selected = ids.slice(0, limit);
    const records = await Promise.all(
      selected.map(async id => {
        try {
          return schema.parse(JSON.parse(await readFile(join(folder, `${id}.json`), 'utf8')));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      })
    );
    return {
      items: records.filter((record): record is Awaited<T> => record !== null),
      ...(ids.length > limit ? { nextCursor: selected[selected.length - 1] } : {}),
    };
  }
}
