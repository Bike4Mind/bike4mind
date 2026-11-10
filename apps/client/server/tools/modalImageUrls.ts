import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3Client } from '@bike4mind/fab-pipeline';
import { Resource } from 'sst';

export const MODAL_IMAGE_PREFIX = 'modal-images/';
export const MODAL_IMAGE_URL_EXPIRY_SECONDS = 60 * 60;

const s3Client = createS3Client();

const isBareKey = (value: string) => value.startsWith(MODAL_IMAGE_PREFIX) && !value.includes('://');

/**
 * Returns the `modal-images/<file>` key for a stored key or a presigned URL of one,
 * or null for anything else (external URLs, other S3 objects).
 */
export function extractModalImageKey(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isBareKey(value)) return value;
  try {
    const key = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
    return isBareKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** Turns a stored modal imageUrl into one a client can load; external URLs pass through unchanged. */
export async function resolveModalImageUrl<T extends string | null | undefined>(imageUrl: T): Promise<T | string> {
  const key = extractModalImageKey(imageUrl);
  if (!key) return imageUrl;
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: Resource.fabFileBucket.name, Key: key }), {
    expiresIn: MODAL_IMAGE_URL_EXPIRY_SECONDS,
  });
}

export async function withSignedModalImage<T extends { imageUrl?: string | null }>(modal: T): Promise<T> {
  if (!modal.imageUrl) return modal;
  return { ...modal, imageUrl: await resolveModalImageUrl(modal.imageUrl) };
}

/** Stable app URL for a stored modal image key (for content that outlives a signature, e.g. email); other URLs pass through. */
export function modalImageAppUrl<T extends string | null | undefined>(imageUrl: T): T | string {
  if (!imageUrl || !isBareKey(imageUrl)) return imageUrl;
  return `${process.env.APP_URL}/api/modal-images/${imageUrl.slice(MODAL_IMAGE_PREFIX.length)}`;
}
