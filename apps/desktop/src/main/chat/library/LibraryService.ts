import { MAX_VIDEO_OUTPUT_BYTES, type PublicImageJob, type VideoGeneration } from '@bike4mind/common';
import type { LibraryItem, LibraryItemRef, LibraryMedia, LibraryPage, LibraryPageRequest } from '@shared/library';
import type { MediaApiClient } from '../media/MediaApiClient';
import { isSupportedMediaType, type MediaStore } from '../media/MediaStore';
import type { StudioJob } from '@shared/studio';

/** The MediaStore bucket the Library downloads into. Cleared at start and on an account change. */
export const LIBRARY_BUCKET = 'library-cache';

export const LIBRARY_PAGE_SIZE = 24;

/** Downloads at once: a page of thumbnails asks for every tile together. */
const MAX_CONCURRENT_DOWNLOADS = 4;

/** Signed URLs remembered from listings, so opening a tile needs no second read of the job. */
const MAX_REMEMBERED_URLS = 500;

/** Bounds the jump lookup: sessions searched, and pages of jobs read from each. */
const MAX_LOCATE_SESSIONS = 200;
const MAX_LOCATE_PAGES = 10;

/** A URL this close to expiry is re-read from the job rather than downloaded. */
const URL_EXPIRY_MARGIN_MS = 30_000;

type Job = PublicImageJob | VideoGeneration;

interface RememberedUrl {
  url: string;
  expiresAt: number | null;
  /** What the job says the file is; a CDN can answer with a generic type. */
  contentType: string;
}

export interface LibraryDeps {
  /** The bearer-bound client and the account scope it belongs to, or null when signed out. */
  connection(): { scope: string; client: MediaApiClient } | null;
  media: Pick<MediaStore, 'save' | 'saveStream' | 'clearReusableBucket'>;
  /** Local sessions to search for the Studio job that produced an item, studio sessions first. */
  sessions(): Promise<{ id: string; mode: string }[]>;
  listJobs(sessionId: string, cursor?: string): Promise<{ items: StudioJob[]; nextCursor?: string } | null>;
  now?: () => number;
}

export function toLibraryItem(job: Job): LibraryItem | null {
  if (!job.output) return null;
  const base = {
    id: job.id,
    prompt: job.prompt,
    model: job.model,
    createdAt: job.created_at,
    availability: job.output.availability,
    contentType: job.output.content_type,
  };
  return job.object === 'video_generation'
    ? {
        ...base,
        medium: 'video',
        durationSeconds: job.output.duration_seconds,
        aspectRatio: job.aspect_ratio,
      }
    : { ...base, medium: 'image' };
}

const keyOf = (ref: LibraryItemRef) => `${ref.medium}:${ref.id}`;

/**
 * The Library place's main-process half: lists the account's finished generations and proxies
 * their bytes into the `b4m-media:` folder, since the renderer can load nothing remote.
 */
export class LibraryService {
  private scope: string | null = null;
  private readonly urls = new Map<string, RememberedUrl>();
  private readonly stored = new Map<string, Promise<LibraryMedia>>();
  private readonly located = new Map<string, string | null>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private clearing: Promise<void>;

  constructor(private readonly deps: LibraryDeps) {
    // Files from an earlier run are unreachable (nothing maps a job to them any more).
    this.clearing = this.clearBucket();
  }

  /** Every download awaits the clear, so a failed one only leaves stale files rather than blocking them all. */
  private clearBucket(): Promise<void> {
    return this.deps.media.clearReusableBucket(LIBRARY_BUCKET).catch(() => {});
  }

  async page(request: LibraryPageRequest): Promise<LibraryPage> {
    const { client } = this.connect();
    const query = { limit: LIBRARY_PAGE_SIZE, ...(request.cursor ? { cursor: request.cursor } : {}) };
    const response =
      request.medium === 'image' ? await client.listImageJobs(query) : await client.listVideoGenerations(query);
    const jobs: Job[] = response.data;
    for (const job of jobs) this.remember(job);
    return {
      items: jobs.flatMap(job => toLibraryItem(job) ?? []),
      nextCursor: response.next_cursor,
    };
  }

  media(ref: LibraryItemRef): Promise<LibraryMedia> {
    this.connect();
    const key = keyOf(ref);
    const cached = this.stored.get(key);
    if (cached) return cached;
    const scope = this.scope;
    const download = this.download(ref).catch((error: unknown) => {
      // A failure is not cached, so opening the item again retries it.
      if (this.scope === scope) this.stored.delete(key);
      throw error;
    });
    this.stored.set(key, download);
    return download;
  }

  async locate(ref: LibraryItemRef): Promise<{ sessionId: string } | null> {
    const { scope } = this.connect();
    const key = keyOf(ref);
    if (this.located.has(key)) {
      const found = this.located.get(key);
      return found ? { sessionId: found } : null;
    }
    const sessions = (await this.deps.sessions())
      .slice()
      .sort((a, b) => Number(b.mode === 'studio') - Number(a.mode === 'studio'))
      .slice(0, MAX_LOCATE_SESSIONS);
    let found: string | null = null;
    for (const session of sessions) {
      found = await this.findInSession(session.id, ref);
      if (found) break;
    }
    if (this.scope === scope) this.located.set(key, found);
    return found ? { sessionId: found } : null;
  }

  private async findInSession(sessionId: string, ref: LibraryItemRef): Promise<string | null> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LOCATE_PAGES; page++) {
      const jobs = await this.deps.listJobs(sessionId, cursor);
      if (!jobs) return null;
      const match = jobs.items.find(
        job => job.kind === ref.medium && (job.providerJobId === ref.id || job.providerJobIds?.includes(ref.id))
      );
      if (match) return match.originatingSessionId;
      if (!jobs.nextCursor) return null;
      cursor = jobs.nextCursor;
    }
    return null;
  }

  /** The current connection; an account change drops every cache tied to the previous one. */
  private connect(): { scope: string; client: MediaApiClient } {
    const connection = this.deps.connection();
    if (!connection) throw new Error('Sign in to see your Library.');
    if (connection.scope !== this.scope) {
      if (this.scope !== null) this.clearing = this.clearing.then(() => this.clearBucket());
      this.scope = connection.scope;
      this.urls.clear();
      this.stored.clear();
      this.located.clear();
    }
    return connection;
  }

  private remember(job: Job) {
    const url = job.output?.url;
    if (!url) return;
    const key = keyOf({ medium: job.object === 'video_generation' ? 'video' : 'image', id: job.id });
    this.urls.delete(key);
    this.urls.set(key, {
      url,
      expiresAt: job.output?.expires_at ? Date.parse(job.output.expires_at) : null,
      contentType: job.output?.content_type ?? '',
    });
    // Map order is insertion order, so the first key is the oldest.
    while (this.urls.size > MAX_REMEMBERED_URLS) {
      const oldest = this.urls.keys().next().value;
      if (oldest === undefined) break;
      this.urls.delete(oldest);
    }
  }

  private async freshUrl(ref: LibraryItemRef, client: MediaApiClient): Promise<RememberedUrl> {
    const now = (this.deps.now ?? Date.now)();
    const known = this.urls.get(keyOf(ref));
    if (known && (known.expiresAt === null || known.expiresAt - URL_EXPIRY_MARGIN_MS > now)) return known;
    const job = ref.medium === 'image' ? await client.getImageJob(ref.id) : await client.getVideoGeneration(ref.id);
    this.remember(job);
    const fresh = this.urls.get(keyOf(ref));
    if (!fresh) {
      throw new Error(
        job.output?.availability === 'pending_scan'
          ? 'This file is still being checked. Try again in a minute.'
          : 'This file is no longer available.'
      );
    }
    return fresh;
  }

  private async download(ref: LibraryItemRef): Promise<LibraryMedia> {
    const { client } = this.connect();
    await this.clearing;
    await this.acquire();
    try {
      const { url, contentType } = await this.freshUrl(ref, client);
      if (ref.medium === 'image') {
        const fetched = await client.fetchGenerated(url);
        const type = isSupportedMediaType(fetched.contentType) ? fetched.contentType : contentType;
        const saved = await this.deps.media.save(LIBRARY_BUCKET, fetched.bytes, type);
        return { url: saved.url, mimeType: saved.mimeType };
      }
      const opened = await client.openVideoDownload(url, new AbortController().signal);
      const saved = await this.deps.media.saveStream(
        LIBRARY_BUCKET,
        opened.stream,
        isSupportedMediaType(opened.contentType) ? opened.contentType : contentType,
        MAX_VIDEO_OUTPUT_BYTES
      );
      return { url: saved.url, mimeType: saved.mimeType };
    } finally {
      this.release();
    }
  }

  private async acquire() {
    if (this.active < MAX_CONCURRENT_DOWNLOADS) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
