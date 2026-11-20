import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { Resource } from 'sst';
import { v4 as uuidv4 } from 'uuid';
import { FabFile } from '@bike4mind/database';
import { BadRequestError, isImageServeable } from '@bike4mind/common';
import { MODAL_IMAGE_PREFIX, extractModalImageKey } from './modalImageUrls';

const s3Client = new S3Client();

// A held/blocked uploaded image must be refused, not swallowed by the copy-failure fallback below.
class ModalImageModerationError extends BadRequestError {}

/**
 * The full object key when `imageUrl` addresses `bucket`, in either S3 URL style
 * (`<bucket>.s3[.<region>].amazonaws.com/<key>` or `s3[.<region>].amazonaws.com/<bucket>/<key>`), else null.
 */
export function bucketObjectKey(imageUrl: string, bucket: string): string | null {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith('.amazonaws.com')) return null;
  const path = url.pathname.replace(/^\/+/, '');
  let rawKey: string | null = null;
  if (url.hostname.startsWith(`${bucket}.s3`)) rawKey = path;
  else if (url.hostname.startsWith('s3') && path.startsWith(`${bucket}/`)) rawKey = path.slice(bucket.length + 1);
  if (!rawKey) return null;
  try {
    return decodeURIComponent(rawKey);
  } catch {
    return null;
  }
}

/** `imageUrl` without its query string when it carries an S3 signature, so a credential is never stored. */
const withoutSignature = (imageUrl: string) => {
  try {
    const url = new URL(imageUrl);
    if (![...url.searchParams.keys()].some(k => k.startsWith('X-Amz-'))) return imageUrl;
    url.search = '';
    return url.toString();
  } catch {
    return imageUrl;
  }
};

/** Copies a modal image from the fab-file bucket to permanent modal storage and returns its S3 key. */
export class ModalImageHandler {
  /**
   * An object URL (signed or not) in the fab-file bucket is copied under `modal-images/` and its key
   * returned, signed at serve time. Any other URL is returned unchanged, minus any S3 signature.
   */
  static async processModalImageUrl(imageUrl: string): Promise<string> {
    const existingKey = extractModalImageKey(imageUrl);
    if (existingKey) return existingKey;

    const bucket = Resource.fabFileBucket.name;
    const sourceKey = bucketObjectKey(imageUrl, bucket);
    if (!sourceKey) return withoutSignature(imageUrl);

    // Refuse to promote a held/blocked uploaded image into a permanent, platform-wide banner. No
    // FabFile match (e.g. a generated image with no upload record) falls through unaffected.
    const fabFile = await FabFile.findOne({ filePath: sourceKey });
    if (fabFile && !isImageServeable(fabFile)) {
      throw new ModalImageModerationError('This image is not available to use as a banner.');
    }

    const fileExt = sourceKey.includes('.') ? sourceKey.split('.').pop() : 'jpg';
    const permanentKey = `${MODAL_IMAGE_PREFIX}${uuidv4()}.${fileExt}`;
    try {
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
          Key: permanentKey,
          MetadataDirective: 'COPY',
        })
      );
      return permanentKey;
    } catch (error) {
      console.error('[ModalImageHandler] Failed to copy modal image; storing the unsigned object URL:', error);
      return withoutSignature(imageUrl);
    }
  }
}
