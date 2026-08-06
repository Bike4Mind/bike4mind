import { folderTagForFile } from '@bike4mind/common';
import type { UploadErrorKind } from '@client/app/stores/useDataLakeWizardStore';
import { slugifyDataLakeName, MIN_DATA_LAKE_SLUG_LENGTH } from '@client/app/hooks/data/dataLakeSlug';
import { uploadFileToUrl } from '@client/app/utils/uploadFileToUrl';
import axios from 'axios';

/** Union of every file's folder tag, for the batch record's appliedTags summary. AI-suggested
 * category tags are no longer part of this - they're applied later, post-upload. */
export function foldersTagsForBatch(
  files: { relativePath: string }[],
  tagPrefix: string
): { name: string; strength: number }[] {
  const byName = new Map<string, number>();
  for (const f of files) {
    for (const tag of folderTagForFile(f.relativePath, tagPrefix)) {
      byName.set(tag.name, tag.strength);
    }
  }
  return Array.from(byName, ([name, strength]) => ({ name, strength }));
}

// -- Hashing & Deduplication --------------------------------------------------

export const HASH_CONCURRENCY = 10;

// -- Batch Upload --------------------------------------------------------------

export const UPLOAD_CONCURRENCY = 5;
export const BATCH_CHUNK_SIZE = 100; // Max files per presigned URL request

/**
 * Canonical offline message. Shared by the mutation's pre-flight guard, the error
 * classifier, and DataLakeWizardModal's pre-flight check so all offline entry points
 * say the same thing.
 */
export const OFFLINE_MESSAGE = 'No internet connection. Check your network and try again.';
// Every file's upload PUT failed even though the lake/batch were created - a transport
// problem (network, CSP blocking the presigned host), not the user's lake settings.
export const UPLOAD_ALL_FAILED_MESSAGE =
  'None of the files could be uploaded. This is usually a network or connection issue, not your data lake settings. Please try again.';

/**
 * Translate an upload/create failure into a distinct kind + human message. The lake
 * config validates server-side with zod, whose raw text (e.g. "Too small: expected
 * string to have >=2 characters at 'slug'") must never reach the UI - so a 422 is
 * re-derived here from the config against the same rules to name the real culprit.
 * Keep the rule thresholds in sync with CreateDataLakeRequestInput (common/schemas/dataLake).
 * `snapshot` is the config/isAppend state at the moment the failing request was made,
 * captured by the caller (store reads don't belong in this pure module).
 */
export function classifyUploadError(
  error: unknown,
  snapshot: { config: { name: string; tagPrefix: string }; isAppend: boolean }
): { kind: UploadErrorKind; message: string } {
  // Network / offline: the request never reached the server, so there's no response body.
  // Covers both the axios transport error and the pre-flight guard's thrown OFFLINE_MESSAGE.
  const isNetworkError =
    (axios.isAxiosError(error) && (error.code === 'ERR_NETWORK' || error.message === 'Network Error')) ||
    (error instanceof Error && error.message === OFFLINE_MESSAGE);
  if (isNetworkError) {
    return { kind: 'network', message: OFFLINE_MESSAGE };
  }

  // All uploads failed (thrown by the batch flow after the lake/batch were rolled back):
  // a transport problem, not a config/validation one.
  if (error instanceof Error && error.message === UPLOAD_ALL_FAILED_MESSAGE) {
    return { kind: 'upload', message: UPLOAD_ALL_FAILED_MESSAGE };
  }

  const status = axios.isAxiosError(error) ? error.response?.status : undefined;

  // 422: the lake name/tag prefix was rejected. Re-derive the culprit from the config
  // rather than surfacing the raw validator string.
  if (status === 422) {
    const { config, isAppend } = snapshot;
    // Only create mode submits a name and prefix; append mode locks both, so neither can be
    // what the server rejected there - fall through to the neutral message instead.
    if (!isAppend) {
      if (slugifyDataLakeName(config.name).length < MIN_DATA_LAKE_SLUG_LENGTH) {
        return {
          kind: 'validation',
          message: 'The data lake name is too short. Use a name with at least 2 letters or numbers.',
        };
      }
      const prefix = config.tagPrefix.endsWith(':') ? config.tagPrefix : `${config.tagPrefix}:`;
      if (prefix.length < 2) {
        return {
          kind: 'validation',
          message: 'The tag prefix is too short. Use at least 2 characters ending in ":" (e.g. "legal:").',
        };
      }
    }
    // Neutral fallback: a 422 can also come from the batch/presigned-URL endpoints or
    // requiredEntitlement, and in append mode the Config fields are locked - so don't
    // claim the name/tag prefix is the culprit when we couldn't confirm it.
    return {
      kind: 'validation',
      message: 'Your data lake settings were rejected. Review them and try again.',
    };
  }

  if (status !== undefined && status >= 500) {
    return { kind: 'server', message: 'The server ran into a problem. Please try again in a moment.' };
  }

  // Other 4xx (403 feature gate, 404, 409, 429, ...) carry a curated server message worth
  // showing. Safe to surface: errorHandler maps every ZodError to a 422, handled above, so
  // no validator text can reach here.
  if (status !== undefined && status >= 400) {
    const data = axios.isAxiosError(error) ? (error.response?.data as Record<string, unknown> | undefined) : undefined;
    const serverMessage = typeof data?.error === 'string' ? data.error : undefined;
    const fallbackMessage = typeof data?.message === 'string' ? data.message : undefined;
    return {
      kind: 'server',
      message: serverMessage || fallbackMessage || 'The request was rejected. Please try again.',
    };
  }

  // Locally-thrown guard errors (e.g. "No files to upload") already carry a friendly message.
  if (error instanceof Error && error.message) {
    return { kind: 'unknown', message: error.message };
  }

  return { kind: 'unknown', message: 'Batch upload failed. Please try again.' };
}

/**
 * Upload one file to the URL the server returned - a same-origin proxy (self-host) or an
 * S3 presigned URL (hosted). The auth routing (authenticated api client vs raw axios) lives
 * in uploadFileToUrl so this and the single-file path stay in sync.
 */
export async function uploadFileToS3(url: string, file: File): Promise<void> {
  await uploadFileToUrl(url, file, file.type);
}

/**
 * Run `worker` over every item in `queue` with at most `limit` in flight at once.
 * Never rejects: a worker failure is the caller's job to account for (both call
 * sites track their own per-item success/failure inside the worker closure), so a
 * throw here is swallowed rather than aborting the other in-flight items.
 */
export async function runWithConcurrency<T>(
  queue: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const items = [...queue];
  const total = items.length;
  if (total === 0) return;

  return new Promise<void>(resolve => {
    let active = 0;
    let done = 0;

    function processNext() {
      while (active < limit && items.length > 0) {
        const item = items.shift()!;
        active++;

        worker(item)
          .catch(() => {
            // Swallow: the pump's contract is "never rejects" - the worker already
            // recorded its own failure (progress/counters) before this catch runs.
          })
          .finally(() => {
            active--;
            done++;
            if (done === total) {
              resolve();
            } else {
              processNext();
            }
          });
      }
    }

    processNext();
  });
}
