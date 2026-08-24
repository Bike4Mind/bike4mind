/**
 * The URL a browser should PUT a new file's bytes to.
 *
 * Hosted (AWS): the direct S3 presigned URL - the browser uploads straight to S3.
 * Self-host: S3 (MinIO) is not browser-reachable and the presign is blocked by the CSP
 * connect-src allow-list, so return a same-origin proxy route (pages/api/files/[id]/upload.ts)
 * that streams the PUT to storage server-side under the same key - the MinIO ObjectCreated
 * webhook + chunk/vectorize pipeline fire unchanged.
 *
 * Both upload entry points - single-file (createFabFile) and batch
 * (generate-presigned-urls-batch, the data-lake wizard path) - MUST route through this so the
 * two can't diverge. They did: the batch path was missing the rewrite, so every self-host
 * data-lake upload hit the CSP-blocked MinIO host and failed.
 */
export const resolveBrowserUploadUrl = (fileId: string, directPresignedUrl: string): string =>
  process.env.B4M_SELF_HOST === 'true' ? `/api/files/${fileId}/upload` : directPresignedUrl;

/**
 * The same rewrite for AppFile uploads (app-files, organization logos, profile photos), which
 * live in the app-files bucket rather than the fab-file bucket and so need their own proxy route
 * (pages/api/app-files/[id]/upload.ts).
 *
 * Every endpoint that hands the browser an app-files presign - app-files/generate-presigned-url,
 * organizations/[id]/upload-logo, users/[id]/upload-photo - MUST route through this, or that
 * upload hits the CSP-blocked MinIO host on self-host.
 */
export const resolveBrowserAppFileUploadUrl = (appFileId: string, directPresignedUrl: string): string =>
  process.env.B4M_SELF_HOST === 'true' ? `/api/app-files/${appFileId}/upload` : directPresignedUrl;

/**
 * The same rewrite for the LLM history import (import-history/upload.ts), which uploads a zip to
 * the history-import bucket rather than a per-file bucket.
 *
 * Unlike the two above there is no id to name, because there is no owning DB record - the key is
 * `<userId>/<source>/<timestamp>.zip`, chosen entirely server-side. That is deliberate and
 * load-bearing: server/s3/historyUploadComplete.ts parses the userId and source back OUT of the
 * key to decide whose import this is, so a client-supplied key would let a caller attribute an
 * import to another user. The proxy therefore takes only the source and recomputes the key from
 * the authenticated request; nothing about the destination is client-controlled.
 */
export const resolveBrowserHistoryImportUploadUrl = (source: string, directPresignedUrl: string): string =>
  process.env.B4M_SELF_HOST === 'true'
    ? `/api/import-history/upload?source=${encodeURIComponent(source)}`
    : directPresignedUrl;
