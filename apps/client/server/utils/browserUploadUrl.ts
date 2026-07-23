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
