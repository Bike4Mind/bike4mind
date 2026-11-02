import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PullJobRequestSchema, PullJobSchema, type PullJob, type PullJobRequest } from '@bike4mind/common/modelHub';

/** What a job learned while running that a restart must not recompute. */
export const RunStateSchema = z.object({
  /** Whether Ollama listed the tag before the first pull; null when it could not say, missing until known. */
  hadTag: z.boolean().nullable().optional(),
  /** The pull finished, so only the check of the installed weights is left. */
  pulled: z.boolean(),
  /** Nothing proved the file before the pull (a gated or private repo), so the check after it is the only one. */
  afterOnly: z.boolean(),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const StoredJobSchema = z.object({
  job: PullJobSchema,
  request: PullJobRequestSchema,
  run: RunStateSchema.optional(),
});
export interface StoredJob {
  job: PullJob;
  request: PullJobRequest;
  run?: RunState;
}

const FILE_NAME = /^([0-9a-f-]{36})\.json$/;
const DRAFT_NAME = /^[0-9a-f-]{36}\.json\.[0-9a-f]{12}$/;
const MAX_FILE_BYTES = 256 * 1024;

export interface JobStore {
  loadAll(): Promise<StoredJob[]>;
  save(record: StoredJob): Promise<void>;
  remove(id: string): Promise<void>;
}

/** One `jobs/<id>.json` per job, replaced by rename so a crash leaves the old copy or the new one. */
export function createJobStore(stateDir: string, log: (line: string) => void): JobStore {
  const dir = join(stateDir, 'jobs');
  const chains = new Map<string, Promise<void>>();
  let ready: Promise<void> | null = null;

  const ensureDir = () =>
    (ready ??= (async () => {
      await mkdir(dir, { recursive: true, mode: 0o750 });
      const info = await lstat(dir);
      if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
      if (info.mode & 0o022) await chmod(dir, 0o750);
    })());

  // Writes to one id run in order, so a slow early save cannot land after a later one.
  const serial = (id: string, task: () => Promise<void>) => {
    const next = (chains.get(id) ?? Promise.resolve()).then(task, task);
    const settled = next.catch(() => undefined);
    chains.set(id, settled);
    void settled.then(() => {
      if (chains.get(id) === settled) chains.delete(id);
    });
    return next;
  };

  async function readOne(name: string): Promise<StoredJob | null> {
    let handle;
    try {
      handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
      const parsed = StoredJobSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
      return parsed.success && `${parsed.data.job.id}.json` === name ? parsed.data : null;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }

  return {
    async loadAll() {
      await ensureDir();
      const all = await readdir(dir);
      // A crash between writing a draft and renaming it leaves the draft behind.
      for (const name of all.filter(entry => DRAFT_NAME.test(entry))) await rm(join(dir, name), { force: true });
      const names = all.filter(name => FILE_NAME.test(name));
      const records: StoredJob[] = [];
      for (const name of names) {
        const record = await readOne(name);
        if (record) records.push(record);
        else log(`skipping unreadable job file ${join(dir, name)}`);
      }
      return records.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt));
    },

    save(record) {
      return serial(record.job.id, async () => {
        await ensureDir();
        const path = join(dir, `${record.job.id}.json`);
        const draft = `${path}.${randomBytes(6).toString('hex')}`;
        const handle = await open(draft, 'wx', 0o640);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`);
          await handle.close();
          await rename(draft, path);
        } catch (error) {
          await handle.close().catch(() => undefined);
          await rm(draft, { force: true });
          throw error;
        }
      });
    },

    remove(id) {
      return serial(id, () => rm(join(dir, `${id}.json`), { force: true }));
    },
  };
}
