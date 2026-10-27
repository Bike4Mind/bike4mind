import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { DownloadVerificationError, LocalRuntimeError, RuntimeConnectionError, RuntimeProtocolError } from './errors';
import { type FileLock, lockFile, onDisk, storageError } from './fileLock';
import type { FetchLike, PullProgress } from './types';

export const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const PROGRESS_INTERVAL_MS = 250;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface DownloadOptions {
  signal?: AbortSignal;
  /**
   * `status` is `resuming` while the bytes kept from an earlier attempt are re-hashed (`completedBytes` counts
   * the bytes hashed), then `downloading`, `verifying` and `success`.
   */
  onProgress?: (progress: PullProgress) => void;
  /** Fails the download when no bytes arrive for this long (ms). Infinity disables the check. */
  idleTimeoutMs?: number;
}

export interface DownloadTarget {
  url: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface DownloadResult {
  path: string;
  sizeBytes: number;
  /** Null when the source published no hash, so only the size was checked. */
  sha256: string | null;
  /** Bytes kept from an earlier attempt; 0 for a fresh download, a source without a hash, or an ignored range. */
  resumedBytes: number;
}

export interface DownloadTransport {
  runtimeId: string;
  fetch: FetchLike;
  /** Headers for one hop, so a token reaches only the origin meant to see it. */
  headersFor(url: URL): Record<string, string>;
  httpError(response: Response, url: URL): Promise<Error>;
  connectionError(error: unknown): unknown;
}

class ProgressCallbackError {
  constructor(readonly error: unknown) {}
}

/**
 * Downloads `target` to `destination` through a resumable `<destination>.partial` under `<destination>.lock`,
 * renaming it into place only after its size and sha256 match. Without a published sha256 it starts over.
 */
export async function downloadFile(
  transport: DownloadTransport,
  target: DownloadTarget,
  destination: string,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  options.signal?.throwIfAborted();
  const lock = await lockFile(destination, transport.runtimeId);
  try {
    return await downloadLocked(transport, target, destination, options, lock);
  } finally {
    await lock.release();
  }
}

async function openPartial(path: string) {
  // Not 'a': Windows refuses to truncate a handle opened for appending.
  return open(path, 'r+').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return open(path, 'w+');
    throw error;
  });
}

async function downloadLocked(
  transport: DownloadTransport,
  target: DownloadTarget,
  destination: string,
  options: DownloadOptions,
  lock: FileLock
): Promise<DownloadResult> {
  const { runtimeId } = transport;
  const name = basename(destination);
  const partial = `${destination}.partial`;
  const disk = <T>(operation: () => Promise<T>) => onDisk(runtimeId, partial, operation);
  const total = target.sizeBytes;
  const expectedSha = target.sha256?.toLowerCase() ?? null;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS;
  const idle = new AbortController();
  const idleError = new LocalRuntimeError(
    `${runtimeId} sent nothing for ${idleTimeoutMs}ms while downloading ${name}`,
    runtimeId
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    if (Number.isFinite(idleTimeoutMs))
      timer = setTimeout(() => idle.abort(idleError), Math.min(idleTimeoutMs, MAX_TIMER_MS));
  };
  const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
  const handle = await disk(() => openPartial(partial));
  let lastReport = 0;
  const report = (status: string, completedBytes: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    try {
      options.onProgress?.({ status, completedBytes, totalBytes: total });
    } catch (error) {
      throw new ProgressCallbackError(error);
    }
  };
  const mismatch = async (check: 'size' | 'sha256', expected: string, actual: string) => {
    await handle.close().catch(() => undefined);
    await rm(partial, { force: true });
    return new DownloadVerificationError(
      `${runtimeId} download of ${name} failed its ${check} check: expected ${expected}, got ${actual}`,
      runtimeId,
      check,
      expected,
      actual
    );
  };

  try {
    let offset = (await disk(() => handle.stat())).size;
    if (offset > total || (offset > 0 && !expectedSha)) {
      await disk(() => handle.truncate(0));
      offset = 0;
    }
    let resumedBytes = offset;
    let hash: Hash | null = expectedSha ? createHash('sha256') : null;
    if (hash && offset > 0) {
      report('resuming', 0, true);
      let hashed = 0;
      try {
        for await (const chunk of createReadStream(partial, { end: offset - 1, signal })) {
          hash.update(chunk as Buffer);
          hashed += (chunk as Buffer).length;
          report('resuming', hashed);
        }
      } catch (error) {
        if (error instanceof ProgressCallbackError || signal.aborted) throw error;
        throw storageError(runtimeId, partial, error, 'read');
      }
    }

    arm();
    let retriedRange = false;
    while (offset < total) {
      const { response, url } = await fetchFollowingRedirects(transport, target.url, offset, signal);
      if (response.status === 416 && offset > 0 && !retriedRange) {
        await response.body?.cancel().catch(() => undefined);
        retriedRange = true;
        await disk(() => handle.truncate(0));
        offset = resumedBytes = 0;
        hash = expectedSha ? createHash('sha256') : null;
        continue;
      }
      if (!response.ok) throw await transport.httpError(response, url);
      if (response.status === 206) {
        const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
        if (!range || Number(range[1]) !== offset || (range[2] !== '*' && Number(range[2]) !== total)) {
          await response.body?.cancel().catch(() => undefined);
          throw new RuntimeProtocolError(`${runtimeId} answered the resume of ${name} with the wrong range`, runtimeId);
        }
      } else if (offset > 0) {
        await disk(() => handle.truncate(0));
        offset = resumedBytes = 0;
        hash = expectedSha ? createHash('sha256') : null;
      }
      if (!response.body) throw new RuntimeProtocolError(`${runtimeId} sent no body for ${name}`, runtimeId);
      report('downloading', offset, true);
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          if (offset + value.length > total) throw await mismatch('size', String(total), `more than ${total}`);
          lock.assertHeld();
          const at = offset;
          await disk(() => handle.write(value, 0, value.length, at));
          hash?.update(value);
          offset += value.length;
          report('downloading', offset);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (offset < total) {
        const message = `${runtimeId} download of ${name} ended at ${offset} of ${total} bytes`;
        throw new RuntimeConnectionError(message, runtimeId, { cause: null });
      }
    }

    report('verifying', offset, true);
    const written = (await disk(() => handle.stat())).size;
    if (written !== total) throw await mismatch('size', String(total), String(written));
    const actualSha = hash?.digest('hex') ?? null;
    if (expectedSha && actualSha !== expectedSha) throw await mismatch('sha256', expectedSha, actualSha ?? '');
    await disk(() => handle.close());
    await lock.verify();
    await onDisk(runtimeId, destination, () => rename(partial, destination));
    report('success', offset, true);
    return { path: destination, sizeBytes: offset, sha256: actualSha, resumedBytes };
  } catch (error) {
    if (error instanceof ProgressCallbackError) throw error.error;
    options.signal?.throwIfAborted();
    if (idle.signal.aborted) throw idleError;
    if (error instanceof LocalRuntimeError) throw error;
    throw transport.connectionError(error);
  } finally {
    clearTimeout(timer);
    await handle.close().catch(() => undefined);
  }
}

async function fetchFollowingRedirects(
  transport: DownloadTransport,
  startUrl: string,
  offset: number,
  signal: AbortSignal
): Promise<{ response: Response; url: URL }> {
  let url = new URL(startUrl);
  for (let hop = 0; ; hop++) {
    const response = await transport.fetch(url.href, {
      headers: {
        ...transport.headersFor(url),
        'accept-encoding': 'identity',
        ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
      },
      signal,
      redirect: 'manual',
    });
    if (response.status < 300 || response.status >= 400) return { response, url };
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    const next = location && URL.canParse(location, url.href) ? new URL(location, url) : null;
    // Never downgrade from https; each hop gets its own headers, so a CDN hop carries no token.
    const allowed = next && (next.protocol === 'https:' || next.protocol === url.protocol);
    if (!next || !allowed || hop >= MAX_DOWNLOAD_REDIRECTS) {
      throw new RuntimeProtocolError(
        `${transport.runtimeId} download redirected somewhere it will not follow`,
        transport.runtimeId
      );
    }
    url = next;
  }
}
