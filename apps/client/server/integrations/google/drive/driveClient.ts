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
  // A GaxiosError with NO response at all is a network-level failure (ECONNRESET, ETIMEDOUT,
  // ENOTFOUND, a socket hangup, ...) - gaxios' own (now-disabled) retry layer covered these via
  // noResponseRetries regardless of the specific code, for any method in httpMethodsToRetry, which
  // GET is. `err.code` on this shape is the system error code, always a STRING (never one of the
  // numeric statuses checked above), so that combination is the signal. All four Drive calls here
  // are idempotent GETs, so retrying is safe.
  if (response == null && typeof err.code === 'string') return true;
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

/**
 * Is this error Drive telling us a stored `changes.list` pageToken is no longer valid (expired, or
 * the corresponding startPageToken was reset)? Classified structurally off the status code, like
 * isDriveRateLimitError - the message text carries no stable marker. Callers MUST treat a true here
 * as "fall back to a full walk", not a permanent failure: an invalid cursor is routine (Drive expires
 * them; see the syncCursor doc comment) and dropping the sync instead would silently stop re-syncing
 * the folder forever.
 */
export function isDriveInvalidCursorError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as Record<string, unknown>;
  const response = err.response as Record<string, unknown> | undefined;
  for (const raw of [err.code, err.status, response?.status]) {
    const code = typeof raw === 'string' ? Number(raw) : raw;
    if (code === 400 || code === 404) return true;
  }
  return false;
}

/**
 * Is this error Drive confirming a file is genuinely gone (a plain 404), as opposed to a transient
 * failure (rate limit, 5xx, network blip)? getFileParents uses this to decide whether an ancestry
 * lookup failure means "this ancestor no longer exists" (safe to fold into null/no-chain) versus
 * "we couldn't tell right now" (must NOT be read the same way - see getFileParents).
 */
export function isDriveNotFoundError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as Record<string, unknown>;
  const response = err.response as Record<string, unknown> | undefined;
  for (const raw of [err.code, err.status, response?.status]) {
    if ((typeof raw === 'string' ? Number(raw) : raw) === 404) return true;
  }
  return false;
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

/**
 * One entry from `drive.changes.list`: either a file that changed (added/edited/moved/re-shared -
 * `file` present) or one that is gone for good (deleted, or the caller lost access - `removed: true`,
 * `file` absent). `file.trashed` is a SEPARATE, softer signal (still resolvable, still in `file`) -
 * both read as "no longer live" by the caller, but only `removed` means Drive will never mention this
 * id again.
 */
export type DriveChange = {
  fileId: string;
  removed: boolean;
  file?: DriveFile & { parents?: string[]; trashed?: boolean };
};

const CHANGES_FIELDS =
  'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, modifiedTime, md5Checksum, size, parents, trashed))';

/**
 * Establish the baseline cursor for incremental sync: the pageToken meaning "now". Call once right
 * BEFORE a full walk (first sync, or a cursor-invalidation fallback - see isDriveInvalidCursorError)
 * and persist the result as the connection's syncCursor only once that walk has been applied.
 *
 * Before, not after, and the order is the point: a file created mid-walk, after its parent folder was
 * already listed, is in neither the walk's result nor a feed read from a token taken afterwards. Taken
 * first, the token instead overlaps the walk - `listChanges` replays some changes the walk already
 * covered, which the caller diffs out as no-ops. Overlap is recoverable; a gap is not.
 */
export async function getStartPageToken(drive: drive_v3.Drive): Promise<string> {
  const res = await withDriveRetry('changes.getStartPageToken', () =>
    drive.changes.getStartPageToken({ supportsAllDrives: true })
  );
  const token = res.data.startPageToken;
  if (!token) {
    throw new Error('Drive did not return a startPageToken');
  }
  return token;
}

/**
 * Pull every change since `pageToken`, following pagination (same page-cap discipline as
 * listFolderChildren - see MAX_LIST_PAGES). The Changes API is Drive-WIDE: it has no folder filter,
 * so this returns every change the credential can see across the whole Drive/shared-drive, not just
 * the connected folder's subtree - narrowing to that subtree is the caller's job (driveLakeIngest
 * resolves per-candidate membership via driveContent.isUnderRoot).
 *
 * `newStartPageToken` is only present on the LAST page and is the cursor to persist for the next
 * poll; a caller that stops paginating early (it never should - see the throw below) would have
 * nothing valid to advance the cursor to.
 */
export async function listChanges(
  drive: drive_v3.Drive,
  pageToken: string
): Promise<{ changes: DriveChange[]; newStartPageToken: string }> {
  const changes: DriveChange[] = [];
  let token: string | undefined = pageToken;
  let newStartPageToken: string | undefined;
  let pages = 0;

  do {
    // Explicit params type: without it, TS's overload resolution against the googleapis
    // client's several list() signatures (callback vs promise vs streamed) infers `res` in
    // terms of itself and fails to compile (TS7022).
    const params: drive_v3.Params$Resource$Changes$List = {
      pageToken: token,
      fields: CHANGES_FIELDS,
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    };
    const res = await withDriveRetry('changes.list', () => drive.changes.list(params));

    for (const c of res.data.changes ?? []) {
      if (!c.fileId) continue;
      const f = c.file;
      changes.push({
        fileId: c.fileId,
        removed: !!c.removed,
        file: f
          ? {
              id: f.id ?? c.fileId,
              name: f.name ?? '',
              mimeType: f.mimeType ?? '',
              ...(f.modifiedTime && { modifiedTime: f.modifiedTime }),
              ...(f.md5Checksum && { md5Checksum: f.md5Checksum }),
              ...(f.size != null && { size: Number(f.size) }),
              ...(f.parents && { parents: f.parents }),
              ...(f.trashed != null && { trashed: f.trashed }),
            }
          : undefined,
      });
    }

    token = res.data.nextPageToken ?? undefined;
    newStartPageToken = res.data.newStartPageToken ?? newStartPageToken;
    pages++;
    if (token && pages >= MAX_LIST_PAGES) {
      throw new Error(`Drive changes feed exceeded ${MAX_LIST_PAGES} pages; listing is not exhaustive`);
    }
  } while (token);

  if (!newStartPageToken) {
    throw new Error('Drive changes.list did not return a newStartPageToken on its last page');
  }
  return { changes, newStartPageToken };
}

/**
 * A file/folder's current direct parent ids, for live ancestor-chain resolution (see
 * driveContent.isUnderRoot). Returns null for anything CONFIRMED unusable as an ancestor: gone (404)
 * or trashed - the conservative (exclude, don't include) side of that check.
 *
 * A transient failure (rate limit, 5xx, network blip) is NOT folded into that same null: isUnderRoot's
 * caller uses a false/null result to decide a tracked file moved out of the connected tree and should
 * be evicted from the lake, so misreading "Drive hiccuped" as "confirmed gone" would silently drop a
 * still-live file (the #2394 failure mode). Rethrown so the caller can tell the two apart.
 */
export async function getFileParents(drive: drive_v3.Drive, fileId: string): Promise<string[] | null> {
  try {
    const res = await withDriveRetry('files.get(parents)', () =>
      drive.files.get({ fileId, fields: 'id, parents, trashed', supportsAllDrives: true })
    );
    if (res.data.trashed) return null;
    return res.data.parents ?? [];
  } catch (e) {
    if (isDriveNotFoundError(e)) return null;
    throw e;
  }
}
