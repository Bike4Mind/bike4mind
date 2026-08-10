import type { drive_v3 } from 'googleapis';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { resolveSupportedMimeType } from '@bike4mind/utils';
import { listFolderChildren, isFolder, type DriveFile } from './driveClient';

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

/**
 * Recursively walk a Drive folder tree, returning every non-folder file with its relativePath.
 * A `visited` set guards against cycles - a Drive folder graph can contain shortcuts/loops, and
 * an unguarded walk would recurse forever. Reuses the one-level `listFolderChildren` primitive.
 */
export async function walkFolder(drive: drive_v3.Drive, rootFolderId: string): Promise<WalkedDriveFile[]> {
  const files: WalkedDriveFile[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; path: string }> = [{ id: rootFolderId, path: '' }];

  while (queue.length > 0) {
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

export type FetchedContent =
  | { ok: true; bytes: Buffer; mimeType: string }
  | { ok: false; reason: 'unsupported' | 'export_too_large' | 'error'; detail?: string };

/**
 * Fetch one Drive file's bytes for ingest:
 * - Google Editors (Docs/Sheets/Slides) -> `files.export` to a chunker-friendly type; other
 *   google-apps types (Forms, Drawings, ...) aren't ingestible and are reported `unsupported`.
 * - Native files -> `files.get?alt=media`, gated by `resolveSupportedMimeType`.
 *
 * Returns a discriminated result so the caller skips-and-counts rather than crashing the whole
 * walk on one bad file (an oversized Editors export, an unsupported type, a transient error).
 */
export async function fetchDriveFileContent(drive: drive_v3.Drive, file: DriveFile): Promise<FetchedContent> {
  try {
    if (file.mimeType.startsWith(GOOGLE_APPS_PREFIX)) {
      const exportMime = EDITOR_EXPORTS[file.mimeType];
      if (!exportMime) {
        return { ok: false, reason: 'unsupported', detail: file.mimeType };
      }
      const res = await drive.files.export({ fileId: file.id, mimeType: exportMime }, { responseType: 'arraybuffer' });
      return { ok: true, bytes: Buffer.from(res.data as ArrayBuffer), mimeType: exportMime };
    }

    // Native file: only ingest types the chunker can actually process.
    const { mimeType, supported } = resolveSupportedMimeType(file.name, file.mimeType);
    if (!supported) {
      return { ok: false, reason: 'unsupported', detail: file.mimeType };
    }
    const res = await drive.files.get(
      { fileId: file.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    return { ok: true, bytes: Buffer.from(res.data as ArrayBuffer), mimeType };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Drive's ~10MB export hard cap surfaces as exportSizeLimitExceeded - skip, don't fail the run.
    if (/exportSizeLimitExceeded/i.test(detail)) {
      return { ok: false, reason: 'export_too_large', detail };
    }
    return { ok: false, reason: 'error', detail };
  }
}
