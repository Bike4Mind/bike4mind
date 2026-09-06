import { createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

/** Thrown when a body passes the byte cap. The route turns this into a 413. */
export class UploadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Upload exceeds the maximum size of ${maxBytes} bytes`);
    this.name = 'UploadTooLargeError';
  }
}

export interface SpooledUpload {
  /** Absolute path to the spooled file. */
  path: string;
  bytes: number;
  /** Remove the temp file and its directory. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

interface SpoolOptions {
  /** File name to spool under; only its extension matters (S3Storage sniffs the destination). */
  filename?: string;
  /** Test seam: receives the temp path as soon as it is known, so an aborted spool can be
   *  checked for leaks. Not used in production code. */
  onPath?: (path: string) => void;
}

/**
 * Stream a request body to a temp file, refusing anything over `maxBytes`.
 *
 * Spooled rather than buffered because this backs the LLM history import, where a real export
 * is routinely 100MB+ and the sibling proxy routes' buffer-into-an-array approach would hold all
 * of it in the app pod at once. S3Storage.upload already accepts a path and turns it into a read
 * stream, so the bytes never need to be resident.
 *
 * The cap is enforced mid-stream, so an oversized upload stops on the chunk that crosses the
 * line rather than after the client has finished sending. A body that aborts for any reason
 * takes its partial file with it; a successful one is the caller's to clean up.
 */
export async function spoolRequestToFile(
  body: AsyncIterable<Buffer>,
  maxBytes: number,
  options: SpoolOptions = {}
): Promise<SpooledUpload> {
  const dir = await mkdtemp(join(tmpdir(), 'b4m-upload-'));
  const path = join(dir, options.filename ?? 'upload.bin');
  options.onPath?.(path);

  let removed = false;
  const cleanup = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await rm(dir, { recursive: true, force: true });
  };

  let bytes = 0;
  try {
    // Count inside the pipeline so the cap trips on the crossing chunk; throwing here tears the
    // pipeline down and closes the write stream, so the partial file is never left open.
    const counted = async function* () {
      for await (const chunk of body) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new UploadTooLargeError(maxBytes);
        yield chunk;
      }
    };
    await pipeline(Readable.from(counted()), createWriteStream(path));
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { path, bytes, cleanup };
}
