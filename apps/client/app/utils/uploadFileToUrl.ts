import axios, { type AxiosRequestConfig } from 'axios';
import { api } from '@client/app/contexts/ApiContext';

/**
 * PUT a new file's bytes to the upload URL the server handed back.
 *
 * - Absolute S3 presigned URL (hosted): raw `axios`, with NO app auth - S3 authorizes via the
 *   signature baked into the URL and rejects unexpected auth headers.
 * - Same-origin proxy path (self-host, starts with '/'): the authenticated `api` client, because
 *   pages/api/files/[id]/upload.ts is a normal baseApi route that needs the Bearer token.
 *
 * Shared by the single-file (fabFiles), batch/data-lake (dataLakeWizard), and generic
 * (filesAPICalls) upload paths so they can't diverge - they did, and self-host uploads 401'd
 * against the proxy. Pairs with the server-side resolveBrowserUploadUrl, which decides the URL
 * shape. `config` forwards axios options (signal, onUploadProgress); Content-Type is always set here.
 */
export async function uploadFileToUrl(
  url: string,
  file: File | Blob,
  contentType?: string,
  config?: AxiosRequestConfig
): Promise<void> {
  const putConfig: AxiosRequestConfig = {
    ...config,
    headers: { 'Content-Type': contentType || file.type || 'application/octet-stream' },
  };
  // Same-origin proxy path (self-host) needs the app's Bearer via `api`; an absolute S3 presign
  // authorizes via its own signature and must use raw axios. Exclude protocol-relative '//host/...'
  // (also passes startsWith('/')) so the Bearer can never be sent to a foreign origin.
  if (url.startsWith('/') && !url.startsWith('//')) {
    await api.put(url, file, putConfig);
  } else {
    await axios.put(url, file, putConfig);
  }
}
