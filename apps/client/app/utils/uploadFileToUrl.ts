import axios from 'axios';
import { api } from '@client/app/contexts/ApiContext';

/**
 * PUT a new file's bytes to the upload URL the server handed back.
 *
 * - Absolute S3 presigned URL (hosted): raw `axios`, with NO app auth - S3 authorizes via the
 *   signature baked into the URL and rejects unexpected auth headers.
 * - Same-origin proxy path (self-host, starts with '/'): the authenticated `api` client, because
 *   pages/api/files/[id]/upload.ts is a normal baseApi route that needs the Bearer token.
 *
 * Shared by the single-file (fabFiles) and batch/data-lake (dataLakeWizard) upload paths so the
 * two can't diverge - they did, and self-host uploads 401'd against the proxy.
 * Pairs with the server-side resolveBrowserUploadUrl, which decides which URL shape to return.
 */
export async function uploadFileToUrl(url: string, file: File | Blob, contentType?: string): Promise<void> {
  const headers = { 'Content-Type': contentType || (file as File).type || 'application/octet-stream' };
  if (url.startsWith('/')) {
    await api.put(url, file, { headers });
  } else {
    await axios.put(url, file, { headers });
  }
}
