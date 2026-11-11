// Download copies are throwaway, so they live under the exports/ prefix the 1-day lifecycle rule reaps
// (infra/buckets.ts, compose.selfhost.yaml) and are purged with the account (packages/server-utils/src/users/purgeAccountFiles.ts).
export const NOTEBOOK_DOWNLOAD_KEY_PREFIX = 'exports/curated-notebooks';

export const NOTEBOOK_DOWNLOAD_URL_TTL_SECONDS = 3600;

export const notebookZipDownloadKey = (userId: string, id: string): string =>
  `${NOTEBOOK_DOWNLOAD_KEY_PREFIX}/${encodeURIComponent(userId)}/batches/${id}.zip`;

export const notebookConvertedDownloadKey = (
  userId: string,
  sessionId: string,
  id: string,
  extension: string
): string => `${NOTEBOOK_DOWNLOAD_KEY_PREFIX}/${encodeURIComponent(userId)}/${sessionId}/${id}${extension}`;
