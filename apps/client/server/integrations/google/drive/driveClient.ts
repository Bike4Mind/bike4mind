import { Logger } from '@bike4mind/observability';
import { auth as googleAuth, drive as driveApi, drive_v3 } from '@googleapis/drive';

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  /** RFC-3339 last-modified time - change detection on re-sync. */
  modifiedTime?: string;
  /** md5 of the content (native binaries only; absent for Google Editors files). */
  md5Checksum?: string;
  /** Size in bytes (native binaries only; absent for Google Editors files). */
  size?: number;
};

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export function isFolder(file: DriveFile): boolean {
  return file.mimeType === FOLDER_MIME_TYPE;
}

// The `errors[].reason` values Drive uses for a throttle. A 403 carries these as often as a 429
// does, and the reason is the ONLY thing separating such a 403 from a genuine permission denial.
const DRIVE_RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'quotaExceeded']);

/**
 * Is this error Drive telling us to slow down, rather than a permanent failure?
 *
 * Read structurally off the GaxiosError (status plus `errors[].reason`, at both the shapes
 * googleapis surfaces them) rather than by matching the message, which carries no stable marker.
 * Callers MUST treat a true here as retryable: a throttle misread as permanent drops the file and
 * still reports the run a success (#2394).
 */
export function isDriveRateLimitError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as Record<string, unknown>;
  const response = err.response as Record<string, unknown> | undefined;
  const data = response?.data as { error?: { errors?: unknown } } | undefined;

  for (const raw of [err.code, err.status, response?.status]) {
    if ((typeof raw === 'string' ? Number(raw) : raw) === 429) return true;
  }

  for (const list of [err.errors, data?.error?.errors]) {
    if (!Array.isArray(list)) continue;
    for (const detail of list) {
      const reason = (detail as { reason?: unknown } | null)?.reason;
      if (typeof reason === 'string' && DRIVE_RATE_LIMIT_REASONS.has(reason)) return true;
    }
  }

  return false;
}

const isTransientDriveStatus = (status: number) => status === 408 || (status >= 500 && status < 600);

/**
 * Worth one more attempt: a throttle, or a Drive hiccup/timeout. Deliberately WIDER than
 * isDriveRateLimitError, which stays the narrow "shed load" signal - a Drive outage retried here
 * and still failing must end at the DLQ where an operator sees it, not be deferred quietly as
 * though it were a quota problem that will pass on its own.
 */
function isRetryableDriveError(e: unknown): boolean {
  if (isDriveRateLimitError(e)) return true;
  if (typeof e !== 'object' || e === null) return false;
  const err = e as Record<string, unknown>;
  const response = err.response as Record<string, unknown> | undefined;
  for (const raw of [err.code, err.status, response?.status]) {
    const status = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof status === 'number' && isTransientDriveStatus(status)) return true;
  }
  return false;
}

// In-process retry budget for a failed Drive call. Deliberately small: this absorbs the
// second-scale blip (a burst against Drive's per-user 100-second bucket), and a throttle that
// outlives it is a sustained quota problem the CALLER has to shed by deferring its work - not
// something to keep sleeping on inside a Lambda with a 10-minute ceiling. Windows of 1s/2s/4s put
// the worst case at 7s of sleep per call; raising the retry count is a budget decision, not a
// tuning one, because the folder walk pays this per THROTTLED folder.
const DRIVE_RETRY_MAX_RETRIES = 3;
const DRIVE_RETRY_BASE_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Run one Drive call, retrying a transient failure with exponential backoff and jitter.
 *
 * This is the ONLY retry layer on the Drive path - createDriveClient turns the googleapis one off
 * (see there for why). It covers the same classes that layer did, plus the 403-with-quota-reason
 * shape it did not retry at all.
 *
 * The jitter is half the window, not a wobble around a fixed delay: several connections sync
 * against ONE Drive project quota, so a fixed backoff just re-collides the same callers at the
 * same new instant and the throttle repeats.
 *
 * A permanent failure (404, a genuine permission denial) rethrows on the first attempt, and an
 * error that outlives the budget rethrows the ORIGINAL, so `isDriveRateLimitError` still identifies
 * a throttle upstream and the caller can defer rather than record a permanent failure (#2395).
 */
export async function withDriveRetry<T>(operation: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= DRIVE_RETRY_MAX_RETRIES || !isRetryableDriveError(e)) throw e;
      const window = DRIVE_RETRY_BASE_DELAY_MS * 2 ** attempt;
      const delayMs = Math.floor(window / 2 + Math.random() * (window / 2));
      Logger.globalInstance.warn('[withDriveRetry] transient Drive failure; backing off', {
        operation,
        attempt: attempt + 1,
        maxRetries: DRIVE_RETRY_MAX_RETRIES,
        rateLimited: isDriveRateLimitError(e),
        delayMs,
      });
      await sleep(delayMs);
    }
  }
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
 *
 * `retry: false` is load-bearing, not a disabling of resilience. googleapis-common opts every
 * request into its own retry layer by default (3 retries over 408/429/5xx), which is
 * DETERMINISTIC - no jitter, so several connections sharing one Drive project quota all come back
 * at the same instant - silent, and blind to the 403-with-quota-reason shape Drive uses as often as
 * a 429. Left on it would also compose with withDriveRetry into ~16 HTTP attempts per call with an
 * unknowable total sleep, inside a handler that has a 10-minute ceiling. One layer, ours, so the
 * budget is knowable and a throttle is visible (#2395).
 */
export function createDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new googleAuth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return driveApi({ version: 'v3', auth, retry: false });
}

/**
 * `ok: false` means Drive never gave an access ANSWER - it throttled us. Modelled as its own arm
 * rather than a flag on the success shape so a caller cannot read `exists: false` off a throttle
 * and tell the user they lost access to their own folder (#2395).
 */
export type FolderAccess =
  | { ok: true; exists: boolean; isFolder: boolean; canRead: boolean }
  | { ok: false; reason: 'rate_limited'; detail?: string };

/**
 * Read-access probe for a single folder, using the CALLER's own Drive credential. Drive returns 404
 * (not 403) for a file the caller can't see, so a successful `files.get` is itself proof the caller
 * can read the folder - that is the signal drive-sync uses to gate the global folder claim (a user
 * must be able to read a folder before they can claim it for a lake). Never throws: a permanent
 * error (no access, bad id) resolves to `exists: false` so the caller fails closed, and a throttle
 * that outlives the retry budget comes back as `ok: false` so the caller can say so instead.
 */
export async function getFolderAccess(drive: drive_v3.Drive, folderId: string): Promise<FolderAccess> {
  if (!isValidDriveFolderId(folderId)) return { ok: true, exists: false, isFolder: false, canRead: false };
  try {
    const res = await withDriveRetry('files.get(folder)', () =>
      drive.files.get({
        fileId: folderId,
        fields: 'id, mimeType, capabilities/canDownload',
        supportsAllDrives: true,
      })
    );
    const file = res.data;
    return {
      ok: true,
      exists: true,
      isFolder: file.mimeType === FOLDER_MIME_TYPE,
      // canDownload is often absent for folders; only an EXPLICIT false denies read.
      canRead: file.capabilities?.canDownload !== false,
    };
  } catch (e) {
    if (isDriveRateLimitError(e)) {
      return { ok: false, reason: 'rate_limited', detail: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, exists: false, isFolder: false, canRead: false };
  }
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
    const res = await withDriveRetry('files.list', () =>
      drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, md5Checksum, size)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken,
      })
    );

    for (const f of res.data.files ?? []) {
      // Skip anything missing an id/name/mimeType - it isn't a usable ingest candidate. Logged
      // rather than dropped quietly: all three are in the requested `fields`, so this should never
      // fire, and under the re-sync reconcile a silent drop reads as "gone from the folder" and
      // unpicks a live file from its lake. If it ever does fire, that has to be visible.
      if (!f.id || !f.name || !f.mimeType) {
        Logger.globalInstance.warn('[listFolderChildren] dropping Drive child missing id/name/mimeType', {
          folderId,
          driveFileId: f.id ?? null,
          hasName: !!f.name,
          hasMimeType: !!f.mimeType,
        });
        continue;
      }
      const file: DriveFile = { id: f.id, name: f.name, mimeType: f.mimeType };
      if (f.modifiedTime) file.modifiedTime = f.modifiedTime;
      if (f.md5Checksum) file.md5Checksum = f.md5Checksum;
      if (f.size != null) file.size = Number(f.size);
      files.push(file);
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
