import { google, drive_v3 } from 'googleapis';

export type DriveFile = { id: string; name: string; mimeType: string };

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export function isFolder(file: DriveFile): boolean {
  return file.mimeType === FOLDER_MIME_TYPE;
}

// Drive file/folder ids are URL-safe tokens ([A-Za-z0-9_-]); the alias 'root' also matches. The
// length bound (real ids are ~33-44 chars) stops ~1MB of legal characters being interpolated into
// the `q` string and sent outbound. Validate before interpolating so a crafted id can't break out.
const DRIVE_FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function isValidDriveFolderId(id: unknown): id is string {
  return typeof id === 'string' && DRIVE_FOLDER_ID_PATTERN.test(id);
}

// Page cap: bounds outbound Drive calls against a pathological/looping pageToken. Exceeding it
// THROWS in listFolderChildren rather than truncating - a partial listing under a "the folder's
// children" contract would silently drop files. 100 x pageSize(1000) = 100k children.
const MAX_LIST_PAGES = 100;

/**
 * Build a per-call Drive v3 client from an OAuth access token.
 *
 * IMPORTANT: constructs a FRESH OAuth2 client every call. Never reuse the module-level
 * singleton in common.ts - its credentials are mutable shared state (`setCredentials`), so
 * concurrent multi-tenant syncs on one process would race and bleed tokens across tenants.
 */
export function createDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

/**
 * List the immediate children of a Drive folder (one level), following pagination.
 *
 * `supportsAllDrives`/`includeItemsFromAllDrives` are set so items that live in a Shared Drive
 * are returned - omitting them silently drops shared-drive items (a bug that passes unit tests
 * and fails in prod). The recursive tree-walk and content download/export are layered on in the
 * ingest job (issue C); this is the read primitive the smoke test and ingest both build on.
 */
export async function listFolderChildren(drive: drive_v3.Drive, folderId: string): Promise<DriveFile[]> {
  // Defense-in-depth: never interpolate an unvalidated id into the query (callers should also
  // validate at their trust boundary).
  if (!isValidDriveFolderId(folderId)) {
    throw new Error(`Invalid Drive folder id: ${folderId}`);
  }

  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });

    for (const f of res.data.files ?? []) {
      // Skip anything missing an id/name/mimeType - it isn't a usable ingest candidate.
      if (f.id && f.name && f.mimeType) {
        files.push({ id: f.id, name: f.name, mimeType: f.mimeType });
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
    pages++;
    // Fail loudly rather than silently truncate: a partial answer under "the folder's children"
    // would let ingest drop files while reporting success. Throwing forces the incremental design
    // at the point it belongs (issue C).
    if (pageToken && pages >= MAX_LIST_PAGES) {
      throw new Error(`Drive folder ${folderId} exceeded ${MAX_LIST_PAGES} pages; listing is not exhaustive`);
    }
  } while (pageToken);

  return files;
}
