import type { drive_v3 } from '@googleapis/drive';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { resolveSupportedMimeType } from '@bike4mind/utils';
import { listFolderChildren, isFolder, isDriveRateLimitError, withDriveRetry, type DriveFile } from './driveClient';

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';
const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';

/** Google Editors export targets -> the persisted, chunker-friendly mime we store. */
const EDITOR_EXPORTS: Record<string, string> = {
  [GOOGLE_DOC]: SupportedFabFileMimeTypes.TXT_PLAIN,
  [GOOGLE_SHEET]: SupportedFabFileMimeTypes.XLSX,
  [GOOGLE_SLIDES]: SupportedFabFileMimeTypes.PPTX,
};

/** A file discovered by the recursive walk, with its path relative to the ingested root. */
export type WalkedDriveFile = DriveFile & { relativePath: string };

// Checked between folders (not pages - a mid-listing pagination cost is bounded separately by
// MAX_LIST_PAGES), so it has to cover the worst case of one MORE folder's listing: withDriveRetry's
// own budget maxes out around 7s of sleep, plus the request itself. Generous margin below that
// because a walk that trips this still has to unwind back out to the caller's shed path before the
// invocation dies.
const WALK_DEADLINE_BUFFER_MS = 60_000;

/**
 * Thrown when a walk runs low on invocation time mid-tree, rather than being killed with the sync
 * claim stranded. Deliberately its own type, not folded into `isDriveRateLimitError` - this is not
 * Drive telling us to slow down, and conflating the two would make a slow-but-healthy walk look like
 * a quota problem to anything that inspects the reason. The caller treats both the same way (shed
 * and let a continuation redo the walk), since neither can finish this attempt (#2395 review).
 */
export class DriveWalkTimeBudgetExceededError extends Error {
  constructor() {
    super('Drive folder walk ran out of invocation time');
    this.name = 'DriveWalkTimeBudgetExceededError';
  }
}

/**
 * Recursively walk a Drive folder tree, returning every non-folder file with its relativePath.
 * A `visited` set guards against cycles - a Drive folder graph can contain shortcuts/loops, and
 * an unguarded walk would recurse forever. Reuses the one-level `listFolderChildren` primitive.
 *
 * `remainingMs`, when given, is checked before every folder: a large tree can now spend the whole
 * invocation just walking (each folder's call carries withDriveRetry's own retry budget on top of
 * the request itself), and without this a slow walk would be killed mid-tree with the sync claim
 * stranded rather than ever reaching the caller's shed-and-retry path (#2395 review).
 *
 * Throws on any listing failure, throttles and a spent time budget included (each page is retried
 * in-process first). A caller that can shed load MUST test the thrown error with
 * `isDriveRateLimitError` or `instanceof DriveWalkTimeBudgetExceededError` and defer: re-running a
 * failed walk costs a fresh listing of every page it already fetched, which adds to the very quota
 * that is exhausted (#2395).
 */
export async function walkFolder(
  drive: drive_v3.Drive,
  rootFolderId: string,
  remainingMs?: () => number
): Promise<WalkedDriveFile[]> {
  const files: WalkedDriveFile[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; path: string }> = [{ id: rootFolderId, path: '' }];

  while (queue.length > 0) {
    if (remainingMs && remainingMs() < WALK_DEADLINE_BUFFER_MS) {
      throw new DriveWalkTimeBudgetExceededError();
    }
    const { id, path } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const children = await listFolderChildren(drive, id);
    for (const child of children) {
      const relativePath = path ? `${path}/${child.name}` : child.name;
      if (isFolder(child)) {
        queue.push({ id: child.id, path: relativePath });
      } else {
        files.push({ ...child, relativePath });
      }
    }
  }

  return files;
}

/**
 * `rate_limited` is the one RETRYABLE failure: Drive throttled us, so the file is fine and the
 * caller must defer it rather than record it skipped. `unsupported`, `export_too_large` and
 * `error` are all permanent for this file's current content.
 */
export type FetchedContent =
  | { ok: true; bytes: Buffer; mimeType: string }
  | { ok: false; reason: 'unsupported' | 'export_too_large' | 'error' | 'rate_limited'; detail?: string };

/**
 * Fetch one Drive file's bytes for ingest:
 * - Google Editors (Docs/Sheets/Slides) -> `files.export` to a chunker-friendly type; other
 *   google-apps types (Forms, Drawings, ...) aren't ingestible and are reported `unsupported`.
 * - Native files -> `files.get?alt=media`, gated by `resolveSupportedMimeType`.
 *
 * Returns a discriminated result so the caller skips-and-counts rather than crashing the whole walk
 * on one bad file (an oversized Editors export, an unsupported type). A throttle is reported as its
 * own `rate_limited` reason - see FetchedContent for why the caller must not conflate the two.
 */
export async function fetchDriveFileContent(drive: drive_v3.Drive, file: DriveFile): Promise<FetchedContent> {
  try {
    if (file.mimeType.startsWith(GOOGLE_APPS_PREFIX)) {
      const exportMime = EDITOR_EXPORTS[file.mimeType];
      if (!exportMime) {
        return { ok: false, reason: 'unsupported', detail: file.mimeType };
      }
      const res = await withDriveRetry('files.export', () =>
        drive.files.export({ fileId: file.id, mimeType: exportMime }, { responseType: 'arraybuffer' })
      );
      return { ok: true, bytes: Buffer.from(res.data as ArrayBuffer), mimeType: exportMime };
    }

    // Native file: only ingest types the chunker can actually process.
    const { mimeType, supported } = resolveSupportedMimeType(file.name, file.mimeType);
    if (!supported) {
      return { ok: false, reason: 'unsupported', detail: file.mimeType };
    }
    const res = await withDriveRetry('files.get(media)', () =>
      drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
    );
    return { ok: true, bytes: Buffer.from(res.data as ArrayBuffer), mimeType };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Drive's ~10MB export hard cap surfaces as exportSizeLimitExceeded - skip, don't fail the run.
    if (/exportSizeLimitExceeded/i.test(detail)) {
      return { ok: false, reason: 'export_too_large', detail };
    }
    // Transient, and reported apart from `error` because the caller treats `error` as a permanent
    // per-file skip - which for a throttle silently drops the file from the lake (#2394). Reaching
    // here means the in-process retries above were already spent, so the caller must defer rather
    // than retry this file again immediately.
    if (isDriveRateLimitError(e)) {
      return { ok: false, reason: 'rate_limited', detail };
    }
    return { ok: false, reason: 'error', detail };
  }
}
