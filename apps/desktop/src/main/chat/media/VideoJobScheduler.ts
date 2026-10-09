import {
  MAX_VIDEO_OUTPUT_BYTES,
  TERMINAL_GENERATION_JOB_STATES,
  videoFileExtension,
  type VideoGeneration,
} from '@bike4mind/common';
import type { ChatVideoJob } from '@shared/chat';
import type { MediaApiClient } from './MediaApiClient';
import type { MediaStore } from './MediaStore';
import { toChatVideoJob, type StoredVideoJob, type VideoJobStore } from './VideoJobStore';

/**
 * Cadence, sized against the server's per-user rate limit on the job read (as low as 10 a
 * minute, and shared with any web tab the user has open): one read at a time across every job,
 * never closer together than REQUEST_GAP_MS, so the whole app stays under ~9 a minute however
 * many jobs are running. Each job then backs off on its own toward MAX_INTERVAL_MS.
 */
const REQUEST_GAP_MS = 7_000;
const FIRST_POLL_MS = 10_000;
const BACKOFF = 1.5;
const MAX_INTERVAL_MS = 30_000;
/** A scan that has not cleared in a minute is slow, not about to finish; the web card backs off the same way. */
const SCAN_MAX_INTERVAL_MS = 5 * 60_000;
const RATE_LIMITED_MS = 60_000;
const ERROR_MAX_INTERVAL_MS = 2 * 60_000;
/**
 * Past this a job is reported as stalled and left alone until the user asks again. Generous on
 * purpose: a self-hosted scan can hold a finished clip for up to ~30 minutes.
 */
const DEADLINE_MS = 60 * 60_000;
/** Clips are tens of megabytes; two at a time keeps a burst of finished jobs off the link. */
const MAX_DOWNLOADS = 2;

export interface VideoJobConnection {
  client: MediaApiClient;
  /** Backend plus account; a stored job is only ever polled from the scope that created it. */
  scope: string;
}

export interface VideoJobSchedulerDeps {
  store: VideoJobStore;
  media: MediaStore;
  /** Null when signed out. Read per request, so an account switch takes effect on the next one. */
  connection(): VideoJobConnection | null;
  emit(sessionId: string, job: ChatVideoJob): void;
  logger: { debug(message: string): void; warn(message: string): void };
}

export interface TrackVideoJob {
  sessionId: string;
  callId: string;
  job: VideoGeneration;
  modelName: string;
  estimatedCredits: number;
}

/** A signed link to the clip, for main to put on the clipboard; never handed to the renderer. */
export type FreshVideoLink = { ok: true; url: string; expiresAt: string | null } | { ok: false; message: string };

interface Tracked {
  sessionId: string;
  jobId: string;
  nextAt: number;
  interval: number;
}

const isTerminal = (state: ChatVideoJob['state']): boolean => TERMINAL_GENERATION_JOB_STATES.includes(state);

/** Whether a stored job still has anything to learn from the server. */
export function needsWork(job: ChatVideoJob): boolean {
  if (job.stalled || job.error) return false;
  if (!isTerminal(job.state)) return true;
  return job.state === 'succeeded' && !job.media && job.availability !== 'unavailable';
}

/** Fold one server read into the stored job. */
export function applyRemote(stored: StoredVideoJob, remote: VideoGeneration, now: Date): StoredVideoJob {
  const output = remote.state === 'succeeded' ? remote.output : null;
  const availability = output && output.availability !== 'ready' ? output.availability : undefined;
  return {
    ...stored,
    state: remote.state,
    progress: remote.progress ?? undefined,
    ...(remote.credits.reserved !== null ? { reservedCredits: remote.credits.reserved } : {}),
    availability,
    error: remote.error?.message ?? (availability === 'unavailable' ? 'This video is no longer available.' : undefined),
    updatedAt: now.toISOString(),
  };
}

/**
 * Every unfinished video job in the app, polled from one timer.
 *
 * One scheduler rather than a timer per card, so cost tracks the number of RUNNING jobs, never
 * the number of messages or videos in the thread: a finished job is never read again, and a
 * thread of a hundred finished clips costs nothing here. A job is tracked from the moment it is
 * created, or from when its conversation's cards are listed after a restart, until it settles,
 * is cancelled, its conversation is deleted or archived, or the app quits.
 */
export class VideoJobScheduler {
  private readonly tracked = new Map<string, Tracked>();
  private readonly downloads = new Map<string, { sessionId: string; controller: AbortController }>();
  private readonly reads = new Set<AbortController>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private lastRequestAt = 0;
  private disposed = false;

  constructor(private readonly deps: VideoJobSchedulerDeps) {}

  /**
   * Record a job the server just accepted, then start following it. The record is on disk
   * before this resolves, so the tool returns only once a crash can no longer lose the card.
   */
  async track(input: TrackVideoJob): Promise<ChatVideoJob> {
    const connection = this.deps.connection();
    if (!connection) throw new Error('Signed out before the video job could be recorded.');
    const now = new Date();
    const base: StoredVideoJob = {
      id: input.job.id,
      callId: input.callId,
      scope: connection.scope,
      modelId: input.job.model,
      modelName: input.modelName,
      prompt: input.job.prompt,
      durationSeconds: input.job.duration_seconds,
      aspectRatio: input.job.aspect_ratio,
      resolution: input.job.resolution,
      estimatedCredits: input.estimatedCredits,
      state: input.job.state,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const job = applyRemote(base, input.job, now);
    await this.save(input.sessionId, job);
    if (needsWork(job)) this.schedule(input.sessionId, job.id, FIRST_POLL_MS);
    return toChatVideoJob(job);
  }

  /** A conversation's jobs; resumes following any unfinished one this scope can reach. */
  async list(sessionId: string): Promise<ChatVideoJob[]> {
    const jobs = await this.deps.store.list(sessionId);
    const scope = this.deps.connection()?.scope;
    for (const job of jobs) {
      if (job.scope === scope && needsWork(job) && !this.isFollowing(job.id)) this.schedule(sessionId, job.id, 0);
    }
    return jobs.map(toChatVideoJob);
  }

  /**
   * Ask the server to cancel. A pending or running job is cancelled server-side shortly after
   * and its credits returned, so it is settled here at once and no longer polled. One already
   * storing has been produced and billed; the server returns it unchanged and it carries on.
   */
  async cancel(sessionId: string, jobId: string): Promise<void> {
    const stored = await this.deps.store.get(sessionId, jobId);
    if (!stored || isTerminal(stored.state)) return;
    const connection = this.requireConnection(stored);
    const remote = await connection.client.cancelVideoGeneration(jobId);
    let next = applyRemote(stored, remote, new Date());
    if (remote.state === 'pending' || remote.state === 'running') {
      next = { ...next, state: 'cancelled', progress: undefined, error: 'The generation was cancelled.' };
    }
    if (!needsWork(next)) this.untrack(jobId);
    await this.save(sessionId, next);
  }

  /** Look again at a job that stalled or whose download failed. */
  async recheck(sessionId: string, jobId: string): Promise<void> {
    const stored = await this.deps.store.get(sessionId, jobId);
    if (!stored || stored.media) return;
    const retryable = stored.stalled || (stored.state === 'succeeded' && stored.availability !== 'unavailable');
    if (!retryable) return;
    const now = new Date().toISOString();
    const next: StoredVideoJob = {
      ...stored,
      stalled: undefined,
      error: undefined,
      followedSince: now,
      updatedAt: now,
    };
    await this.save(sessionId, next);
    this.schedule(sessionId, jobId, 0);
  }

  /** The downloaded clip on disk, for Open and Save. */
  async localFile(sessionId: string, jobId: string): Promise<{ path: string; mimeType: string } | null> {
    const stored = await this.deps.store.get(sessionId, jobId);
    const name = stored?.media?.url.split('/').pop();
    if (!name) return null;
    const file = await this.deps.media.locate(sessionId, name);
    return file ? { path: file.path, mimeType: file.mimeType } : null;
  }

  /**
   * A freshly signed server link for Copy link. Read on demand rather than kept, because each
   * one dies 15 minutes after it is signed.
   */
  async freshLink(sessionId: string, jobId: string): Promise<FreshVideoLink> {
    const stored = await this.deps.store.get(sessionId, jobId);
    if (!stored || stored.state !== 'succeeded') return { ok: false, message: 'This video is not finished.' };
    const connection = this.deps.connection();
    if (!connection || connection.scope !== stored.scope) {
      return { ok: false, message: 'Sign in to the account that made this video to copy its link.' };
    }
    try {
      const remote = await connection.client.getVideoGeneration(jobId);
      const output = remote.output;
      if (output?.availability !== 'ready' || !output.url || !/^https?:\/\//i.test(output.url)) {
        return { ok: false, message: 'The server has no link for this video right now.' };
      }
      return { ok: true, url: output.url, expiresAt: output.expires_at };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not read the video job.' };
    }
  }

  /** The conversation is being deleted: stop everything and keep nothing from writing it back. */
  forgetSession(sessionId: string): void {
    this.deps.store.forget(sessionId);
    this.stopSession(sessionId);
  }

  /** Archived: stop following its jobs. Listing its cards again resumes them. */
  stopSession(sessionId: string): void {
    for (const [jobId, entry] of this.tracked) if (entry.sessionId === sessionId) this.tracked.delete(jobId);
    for (const [jobId, download] of this.downloads) {
      if (download.sessionId !== sessionId) continue;
      download.controller.abort();
      this.downloads.delete(jobId);
    }
    this.arm();
  }

  /** App quit. Nothing is cancelled server-side; an unfinished job resumes when next listed. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.tracked.clear();
    for (const controller of this.reads) controller.abort();
    for (const { controller } of this.downloads.values()) controller.abort();
    this.downloads.clear();
  }

  /** For tests and diagnostics: the jobs currently being followed. */
  following(): string[] {
    return [...this.tracked.keys(), ...this.downloads.keys()];
  }

  private isFollowing(jobId: string): boolean {
    return this.tracked.has(jobId) || this.downloads.has(jobId);
  }

  private requireConnection(stored: StoredVideoJob): VideoJobConnection {
    const connection = this.deps.connection();
    if (!connection || connection.scope !== stored.scope) {
      throw new Error('Sign in to the account that started this video to change it.');
    }
    return connection;
  }

  private schedule(sessionId: string, jobId: string, delayMs: number, interval = FIRST_POLL_MS): void {
    if (this.disposed) return;
    this.tracked.set(jobId, { sessionId, jobId, nextAt: Date.now() + delayMs, interval });
    this.arm();
  }

  private untrack(jobId: string): void {
    this.tracked.delete(jobId);
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || this.polling || this.tracked.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.tracked.values()) earliest = Math.min(earliest, entry.nextAt);
    const at = Math.max(earliest, this.lastRequestAt + REQUEST_GAP_MS);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, at - Date.now()));
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    const now = Date.now();
    let due: Tracked | undefined;
    for (const entry of this.tracked.values()) {
      if (entry.nextAt <= now && (!due || entry.nextAt < due.nextAt)) due = entry;
    }
    if (!due) {
      this.arm();
      return;
    }
    this.polling = true;
    this.lastRequestAt = now;
    try {
      await this.poll(due);
    } catch (error) {
      this.deps.logger.warn(
        `VIDEO: poll of ${due.jobId} failed: ${error instanceof Error ? error.message : 'unknown'}`
      );
    } finally {
      this.polling = false;
      this.arm();
    }
  }

  private async poll(entry: Tracked): Promise<void> {
    const stored = await this.deps.store.get(entry.sessionId, entry.jobId);
    if (!stored || !needsWork(stored)) {
      this.tracked.delete(entry.jobId);
      return;
    }
    const connection = this.deps.connection();
    // Signed out, or now speaking for another backend or account: leave it for a later listing
    // in the right scope rather than read it as someone else and record a 404 as its fate.
    if (!connection || connection.scope !== stored.scope) {
      this.tracked.delete(entry.jobId);
      return;
    }
    if (Date.now() - Date.parse(stored.followedSince ?? stored.createdAt) > DEADLINE_MS) {
      this.tracked.delete(entry.jobId);
      await this.save(entry.sessionId, { ...stored, stalled: true, updatedAt: new Date().toISOString() });
      return;
    }

    const controller = new AbortController();
    this.reads.add(controller);
    let remote: VideoGeneration;
    try {
      remote = await connection.client.getVideoGeneration(entry.jobId, controller.signal);
    } catch (error) {
      if (this.tracked.get(entry.jobId) !== entry) return;
      this.onReadFailure(entry, stored, error);
      return;
    } finally {
      this.reads.delete(controller);
    }
    // Cancelled, forgotten or superseded while the read was out: its answer is stale.
    if (this.tracked.get(entry.jobId) !== entry) return;

    const next = applyRemote(stored, remote, new Date());
    await this.save(entry.sessionId, next);
    if (this.tracked.get(entry.jobId) !== entry) return;

    const output = remote.state === 'succeeded' ? remote.output : null;
    if (output?.availability === 'ready' && output.url) {
      this.tracked.delete(entry.jobId);
      this.download(entry.sessionId, next, output.url, output.content_type);
      return;
    }
    if (!needsWork(next)) {
      this.tracked.delete(entry.jobId);
      return;
    }
    const cap = output?.availability === 'pending_scan' ? SCAN_MAX_INTERVAL_MS : MAX_INTERVAL_MS;
    const interval = Math.min(Math.round(entry.interval * BACKOFF), cap);
    this.tracked.set(entry.jobId, { ...entry, nextAt: Date.now() + interval, interval });
  }

  private onReadFailure(entry: Tracked, stored: StoredVideoJob, error: unknown): void {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      this.tracked.delete(entry.jobId);
      void this.save(entry.sessionId, { ...stored, error: 'The server no longer has this video job.' });
      return;
    }
    if (status === 401 || status === 403) {
      this.tracked.delete(entry.jobId);
      return;
    }
    if (status === 429) {
      this.lastRequestAt = Date.now() + RATE_LIMITED_MS - REQUEST_GAP_MS;
      this.tracked.set(entry.jobId, { ...entry, nextAt: Date.now() + RATE_LIMITED_MS });
      return;
    }
    // Offline or a server blip: the job runs regardless, so keep asking, less often.
    const interval = Math.min(entry.interval * 2, ERROR_MAX_INTERVAL_MS);
    this.tracked.set(entry.jobId, { ...entry, nextAt: Date.now() + interval, interval });
  }

  /**
   * Fetch the finished clip into this app's media folder. The player only ever loads that local
   * copy: the signed URL expires in 15 minutes, and the renderer's CSP admits no remote media.
   */
  private download(sessionId: string, job: StoredVideoJob, url: string, contentType: string): void {
    if (this.downloads.has(job.id)) return;
    if (this.downloads.size >= MAX_DOWNLOADS) {
      // Re-read later rather than queue the URL: by then it may have expired.
      this.schedule(sessionId, job.id, MAX_INTERVAL_MS);
      return;
    }
    const connection = this.deps.connection();
    if (!connection) return;
    const controller = new AbortController();
    this.downloads.set(job.id, { sessionId, controller });

    void (async () => {
      try {
        const opened = await connection.client.openVideoDownload(url, controller.signal);
        // Storage often labels objects as octet-stream; the job's own content type is authoritative.
        const mimeType = videoFileExtension(opened.contentType.split(';')[0].trim()) ? opened.contentType : contentType;
        const saved = await this.deps.media.saveStream(sessionId, opened.stream, mimeType, MAX_VIDEO_OUTPUT_BYTES);
        if (controller.signal.aborted) return;
        await this.save(sessionId, {
          ...job,
          media: { url: saved.url, mimeType: saved.mimeType, byteLength: saved.byteLength },
          availability: undefined,
          error: undefined,
          stalled: undefined,
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const reason = error instanceof Error ? error.message : 'unknown error';
        await this.save(sessionId, {
          ...job,
          stalled: true,
          error: `The video finished but could not be downloaded: ${reason}`,
          updatedAt: new Date().toISOString(),
        });
      } finally {
        if (this.downloads.get(job.id)?.controller === controller) this.downloads.delete(job.id);
      }
    })();
  }

  private async save(sessionId: string, job: StoredVideoJob): Promise<void> {
    if (this.disposed) return;
    if (await this.deps.store.upsert(sessionId, job)) this.deps.emit(sessionId, toChatVideoJob(job));
  }
}
