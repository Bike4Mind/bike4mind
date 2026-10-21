import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatVideoJob } from '@shared/chat';
import type { MediaStore } from './MediaStore';

const FILE_NAME = 'video-jobs.json';

/**
 * A job as stored: the card's view plus which backend and account it belongs to. Polling with
 * the wrong account's client would 404 a job that is fine, and mark it failed for good.
 */
export interface StoredVideoJob extends ChatVideoJob {
  scope: string;
  /** When polling last started over (a "Check again"); the stall deadline runs from here. */
  followedSince?: string;
}

/**
 * A conversation's video jobs, in a file beside its media.
 *
 * Beside the media rather than in the session file because a reply is written only when its
 * turn settles, and the job has to be on disk the moment the server accepts it. In the media
 * folder so deleting the conversation takes the records with the clips. The protocol handler
 * serves only names MediaStore generated, so this file is never reachable from the renderer.
 *
 * Writes for one conversation are chained so two updates landing together - a poll and a
 * cancel - cannot interleave their read-modify-write and lose one.
 */
export class VideoJobStore {
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Conversations deleted this run; a poll that lands afterwards must not recreate the folder. */
  private readonly forgotten = new Set<string>();

  constructor(private readonly media: MediaStore) {}

  async list(sessionId: string): Promise<StoredVideoJob[]> {
    await this.chains.get(sessionId)?.catch(() => undefined);
    return this.read(sessionId);
  }

  async get(sessionId: string, jobId: string): Promise<StoredVideoJob | undefined> {
    return (await this.list(sessionId)).find(job => job.id === jobId);
  }

  /** Insert or replace by job id. Resolves once it is on disk; false when the conversation is gone. */
  upsert(sessionId: string, job: StoredVideoJob): Promise<boolean> {
    return this.serialize(sessionId, async () => {
      if (this.forgotten.has(sessionId)) return false;
      const jobs = await this.read(sessionId);
      const index = jobs.findIndex(existing => existing.id === job.id);
      if (index >= 0) jobs[index] = job;
      else jobs.push(job);
      await this.write(sessionId, jobs);
      return true;
    });
  }

  /** Called before the conversation's folder is removed. */
  forget(sessionId: string): void {
    this.forgotten.add(sessionId);
  }

  private serialize<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.chains.set(sessionId, next);
    const settle = () => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    };
    void next.then(settle, settle);
    return next;
  }

  private path(sessionId: string): string {
    return join(this.media.directoryFor(sessionId), FILE_NAME);
  }

  private async read(sessionId: string): Promise<StoredVideoJob[]> {
    let contents: string;
    try {
      contents = await readFile(this.path(sessionId), 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      return Array.isArray(parsed) ? parsed.filter(isStoredJob) : [];
    } catch {
      return [];
    }
  }

  private async write(sessionId: string, jobs: StoredVideoJob[]): Promise<void> {
    const path = this.path(sessionId);
    await mkdir(this.media.directoryFor(sessionId), { recursive: true });
    // Write-then-rename, as SessionStore does, so a crash mid-write cannot lose every card.
    await writeFile(`${path}.tmp`, JSON.stringify(jobs), 'utf8');
    await rename(`${path}.tmp`, path);
  }
}

function isStoredJob(value: unknown): value is StoredVideoJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<StoredVideoJob>;
  return typeof job.id === 'string' && typeof job.callId === 'string' && typeof job.state === 'string';
}

/** The card's view of a stored job: the scope is main's business only. */
export function toChatVideoJob({ scope: _scope, followedSince: _followedSince, ...job }: StoredVideoJob): ChatVideoJob {
  return job;
}
