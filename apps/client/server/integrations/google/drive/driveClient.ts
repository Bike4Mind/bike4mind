import { google, drive_v3 } from 'googleapis';

export type DriveFile = { id: string; name: string; mimeType: string };

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export function isFolder(file: DriveFile): boolean {
  return file.mimeType === FOLDER_MIME_TYPE;
}

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
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

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
  } while (pageToken);

  return files;
}
