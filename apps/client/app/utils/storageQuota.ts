import axios from 'axios';
import prettyBytes from 'pretty-bytes';
import type { IUserDocument } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { isImageFile } from './imageResizer';

// Must stay in sync with checkStorageLimit (b4m-core/utils/src/user.ts): the limit is stored in
// MB, converted with 1e6, and defaults to 1000 when unset.
const DEFAULT_STORAGE_LIMIT_MB = 1000;
const BYTES_PER_MB = 1_000_000;
const STORAGE_WARNING_PERCENT = 90;

/** Substring common to both of the server's storage refusals - checkStorageLimit's "File size
 * exceeds storage limit" and checkOrganizationStorageLimit's "Organization storage limit exceeded"
 * (b4m-core/utils/src/user.ts) - matched to surface either verbatim. */
const SERVER_STORAGE_LIMIT_MESSAGE = 'storage limit';

export interface StorageQuota {
  usedBytes: number;
  limitBytes: number;
}

export type StorageCheck =
  | { status: 'ok' }
  | { status: 'near'; quota: StorageQuota; percent: number }
  | { status: 'exceeds'; quota: StorageQuota; uploadBytes: number; bytesToFree: number };

export function getStorageQuota(
  user: Pick<IUserDocument, 'storageLimit' | 'currentStorageSize'> | null | undefined
): StorageQuota | null {
  // The persisted user stub carries no storage fields until /api/identify lands, and unknown
  // usage must never block an upload - the server stays the hard boundary.
  if (!user || typeof user.currentStorageSize !== 'number') return null;
  return {
    usedBytes: user.currentStorageSize,
    limitBytes: (user.storageLimit ?? DEFAULT_STORAGE_LIMIT_MB) * BYTES_PER_MB,
  };
}

/** Judges an upload of `uploadBytes` against the headroom, by the same rule the server applies. */
export function checkStorageForUpload(quota: StorageQuota | null, uploadBytes: number): StorageCheck {
  if (!quota) return { status: 'ok' };
  const projectedBytes = quota.usedBytes + uploadBytes;
  if (projectedBytes > quota.limitBytes) {
    return { status: 'exceeds', quota, uploadBytes, bytesToFree: projectedBytes - quota.limitBytes };
  }
  const percent = quota.limitBytes > 0 ? (projectedBytes / quota.limitBytes) * 100 : 100;
  if (percent >= STORAGE_WARNING_PERCENT) return { status: 'near', quota, percent };
  return { status: 'ok' };
}

const defaultRefreshUser = () => useUser.getState().refreshUser();

/** Re-judges `compute` on a fresh /api/identify once, if it first refuses. The cached usage is not
 * refreshed when files are deleted, so a stale figure must not block an upload the server would
 * accept. `refresh` is injectable so a caller that must not import a store write action directly
 * (e.g. dataLakeUploadPipeline's getState-only contract) can supply its own. */
async function checkStorageFresh(compute: () => StorageCheck, refresh: () => Promise<void>): Promise<StorageCheck> {
  const check = compute();
  if (check.status !== 'exceeds') return check;
  await refresh();
  return compute();
}

/** checkStorageForUpload against the current user, re-judged fresh on an initial refusal. */
export async function checkStorageForUploadFresh(
  uploadBytes: number,
  refresh: () => Promise<void> = defaultRefreshUser
): Promise<StorageCheck> {
  return checkStorageFresh(
    () => checkStorageForUpload(getStorageQuota(useUser.getState().currentUser), uploadBytes),
    refresh
  );
}

// Must stay in sync with createFabFileOnServerWithUpload (utils/filesAPICalls.ts), which resizes
// images above this size down to it before the server measures them.
const ATTACH_IMAGE_RESIZE_BYTES = 3 * 1024 * 1024;

// The resizer (imageResizer.ts) accepts any result between 85% and 100% of that cap, so the true
// post-resize size of an oversized image is not the cap itself, only bounded by it.
const ATTACH_IMAGE_RESIZE_MIN_RATIO = 0.85;

/** The most bytes a single attached file will count against storage once it reaches the server. */
export function attachUploadBytes(file: File): number {
  return isImageFile(file) ? Math.min(file.size, ATTACH_IMAGE_RESIZE_BYTES) : file.size;
}

/** The fewest bytes an oversized image could count once resized - the low end of the range the
 * flat resize cap only approximates. */
function attachUploadBytesLowerBound(file: File): number {
  return isImageFile(file) && file.size > ATTACH_IMAGE_RESIZE_BYTES
    ? Math.round(ATTACH_IMAGE_RESIZE_BYTES * ATTACH_IMAGE_RESIZE_MIN_RATIO)
    : attachUploadBytes(file);
}

/**
 * checkStorageForUpload for an attached file, but an oversized image's cap estimate is a worst
 * case, not its true post-resize size: when only that worst case would exceed the limit, this
 * downgrades to whatever the best-case (post-resize) size would yield instead of refusing an
 * upload the server might still accept.
 */
export function checkAttachStorage(quota: StorageQuota | null, file: File): StorageCheck {
  const worstCase = checkStorageForUpload(quota, attachUploadBytes(file));
  if (worstCase.status !== 'exceeds') return worstCase;
  const bestCase = checkStorageForUpload(quota, attachUploadBytesLowerBound(file));
  return bestCase.status === 'exceeds' ? worstCase : bestCase;
}

/** checkAttachStorage against the current user, re-judged fresh on an initial refusal. */
export async function checkAttachStorageFresh(file: File): Promise<StorageCheck> {
  return checkStorageFresh(
    () => checkAttachStorage(getStorageQuota(useUser.getState().currentUser), file),
    defaultRefreshUser
  );
}

export function storageExceededMessage(check: Extract<StorageCheck, { status: 'exceeds' }>): string {
  const { quota, uploadBytes, bytesToFree } = check;
  return (
    `Not enough storage: you are using ${prettyBytes(quota.usedBytes)} of ${prettyBytes(quota.limitBytes)}, ` +
    `and this upload needs ${prettyBytes(uploadBytes)}. Free up at least ${prettyBytes(bytesToFree)} to continue.`
  );
}

export function storageNearLimitMessage(check: Extract<StorageCheck, { status: 'near' }>): string {
  const { quota, percent } = check;
  return (
    `You are close to your storage limit: after this upload you will be using ${Math.min(100, Math.round(percent))}% ` +
    `(${prettyBytes(quota.usedBytes)} used of ${prettyBytes(quota.limitBytes)} before it).`
  );
}

/** Thrown by a pre-flight check so an upload is refused before any server call. */
export class StorageLimitExceededError extends Error {
  constructor(check: Extract<StorageCheck, { status: 'exceeds' }>) {
    super(storageExceededMessage(check));
    this.name = 'StorageLimitExceededError';
  }
}

/** The server's storage-limit refusal message, or undefined when `error` is anything else. */
export function serverStorageLimitMessage(error: unknown): string | undefined {
  if (!axios.isAxiosError(error) || error.response?.status !== 400) return undefined;
  const data = error.response.data as { error?: unknown; message?: unknown } | undefined;
  const message = typeof data?.error === 'string' ? data.error : data?.message;
  return typeof message === 'string' && message.includes(SERVER_STORAGE_LIMIT_MESSAGE) ? message : undefined;
}
