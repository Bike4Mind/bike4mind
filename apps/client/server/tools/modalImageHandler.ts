import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { Resource } from 'sst';
import { v4 as uuidv4 } from 'uuid';
import { FabFile } from '@bike4mind/database';
import { isImageServeable } from '@bike4mind/common';
import { MODAL_IMAGE_PREFIX, extractModalImageKey } from './modalImageUrls';

const s3Client = new S3Client();

// A held/blocked uploaded image must be refused, not silently swallowed by
// the catch-all below (which falls back to returning the original URL for infra errors).
class ModalImageModerationError extends Error {}

/** Copies a modal image from a temporary presigned URL to permanent storage and returns its S3 key. */
export class ModalImageHandler {
  /**
   * Process an image URL for modal storage
   * If the URL is a presigned S3 URL, copy it to permanent modal storage and return the key
   * (signed at serve time). Otherwise, return the URL as-is (for external URLs)
   */
  static async processModalImageUrl(imageUrl: string): Promise<string> {
    const existingKey = extractModalImageKey(imageUrl);
    if (existingKey) return existingKey;

    try {
      // Quick check for external URLs - return immediately without processing
      if (!imageUrl.includes('amazonaws.com') && !imageUrl.includes('X-Amz-Algorithm')) {
        console.log('[ModalImageHandler] External URL detected, skipping S3 processing:', imageUrl);
        return imageUrl;
      }

      // Check if this is an S3 presigned URL from our bucket
      if (imageUrl.includes(Resource.fabFileBucket.name) || imageUrl.includes('X-Amz-Algorithm')) {
        // Extract the S3 key from the presigned URL
        const urlObj = new URL(imageUrl);
        const pathParts = urlObj.pathname.split('/');
        const originalKey = pathParts[pathParts.length - 1].split('?')[0];

        // Refuse to promote a held/blocked uploaded image into a permanent,
        // platform-wide banner. No FabFile match (e.g. a generated
        // image with no upload record) falls through unaffected.
        const fabFile = await FabFile.findOne({ filePath: originalKey });
        if (fabFile && !isImageServeable(fabFile)) {
          throw new ModalImageModerationError('This image is not available to use as a banner.');
        }

        // Generate a new permanent key for the modal image
        const fileExt = originalKey.split('.').pop() || 'jpg';
        const permanentKey = `${MODAL_IMAGE_PREFIX}${uuidv4()}.${fileExt}`;

        // Copy the object to the permanent location
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: Resource.fabFileBucket.name,
            CopySource: `${Resource.fabFileBucket.name}/${originalKey}`,
            Key: permanentKey,
            MetadataDirective: 'COPY',
          })
        );

        return permanentKey;
      }

      // For external URLs or already permanent URLs, return as-is
      return imageUrl;
    } catch (error) {
      // A moderation refusal must propagate - never fall back to the original URL.
      if (error instanceof ModalImageModerationError) {
        throw error;
      }
      console.error('[ModalImageHandler] Error processing modal image URL:', error);
      // Return original URL if processing fails
      return imageUrl;
    }
  }
}
