import { S3Client, CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Resource } from 'sst';
import { v4 as uuidv4 } from 'uuid';
import { FabFile } from '@bike4mind/database';
import { isImageServeable } from '@bike4mind/common';

const s3Client = new S3Client();

// A held/blocked uploaded image must be refused, not silently swallowed by
// the catch-all below (which falls back to returning the original URL for infra errors).
class ModalImageModerationError extends Error {}

/**
 * Handles modal images by copying them from temporary presigned URLs to permanent storage
 * and generating long-lived URLs for modal display
 */
export class ModalImageHandler {
  private static readonly MODAL_IMAGE_PREFIX = 'modal-images/';
  private static readonly URL_EXPIRY_SECONDS = 365 * 24 * 60 * 60; // 1 year

  /**
   * Process an image URL for modal storage
   * If the URL is a presigned S3 URL, copy it to permanent modal storage
   * Otherwise, return the URL as-is (for external URLs)
   */
  static async processModalImageUrl(imageUrl: string): Promise<string> {
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
        // long-lived (1 year) platform-wide banner. No FabFile match (e.g. a generated
        // image with no upload record) falls through unaffected.
        const fabFile = await FabFile.findOne({ filePath: originalKey });
        if (fabFile && !isImageServeable(fabFile)) {
          throw new ModalImageModerationError('This image is not available to use as a banner.');
        }

        // Generate a new permanent key for the modal image
        const fileExt = originalKey.split('.').pop() || 'jpg';
        const permanentKey = `${this.MODAL_IMAGE_PREFIX}${uuidv4()}.${fileExt}`;

        // Copy the object to the permanent location
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: Resource.fabFileBucket.name,
            CopySource: `${Resource.fabFileBucket.name}/${originalKey}`,
            Key: permanentKey,
            MetadataDirective: 'COPY',
          })
        );

        // Generate a long-lived presigned URL for the permanent location
        const command = new GetObjectCommand({
          Bucket: Resource.fabFileBucket.name,
          Key: permanentKey,
        });

        const permanentUrl = await getSignedUrl(s3Client, command, {
          expiresIn: this.URL_EXPIRY_SECONDS,
        });

        return permanentUrl;
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

  /**
   * Process multiple image URLs for a modal
   */
  static async processModalImages(images: string[]): Promise<string[]> {
    const processedImages = await Promise.all(images.map(url => this.processModalImageUrl(url)));
    return processedImages;
  }

  /**
   * Check if an image URL is expired and needs refreshing
   */
  static isUrlExpired(url: string): boolean {
    try {
      // Check for AWS presigned URL expiration parameters
      if (url.includes('X-Amz-Expires') && url.includes('X-Amz-Date')) {
        const urlObj = new URL(url);
        const amzDate = urlObj.searchParams.get('X-Amz-Date');
        const amzExpires = urlObj.searchParams.get('X-Amz-Expires');

        if (amzDate && amzExpires) {
          // Parse the date (format: YYYYMMDDTHHMMSSZ)
          const year = parseInt(amzDate.substring(0, 4));
          const month = parseInt(amzDate.substring(4, 6)) - 1; // JS months are 0-indexed
          const day = parseInt(amzDate.substring(6, 8));
          const hour = parseInt(amzDate.substring(9, 11));
          const minute = parseInt(amzDate.substring(11, 13));
          const second = parseInt(amzDate.substring(13, 15));

          const startDate = new Date(Date.UTC(year, month, day, hour, minute, second));
          const expiresInMs = parseInt(amzExpires) * 1000;
          const expirationDate = new Date(startDate.getTime() + expiresInMs);

          // Check if expired (with 5 minute buffer)
          const now = new Date();
          const bufferMs = 5 * 60 * 1000; // 5 minutes
          return now.getTime() > expirationDate.getTime() - bufferMs;
        }
      }
      return false;
    } catch (error) {
      console.error('[ModalImageHandler] Error checking URL expiration:', error);
      return false;
    }
  }

  /**
   * Refresh an expired modal image URL
   */
  static async refreshModalImageUrl(modalId: string, oldUrl: string): Promise<string> {
    try {
      // Extract the key from the old URL
      const urlObj = new URL(oldUrl);
      const pathParts = urlObj.pathname.split('/');
      const key = pathParts[pathParts.length - 1].split('?')[0];

      // If it's already a modal image, just regenerate the URL
      if (key.startsWith(this.MODAL_IMAGE_PREFIX)) {
        const command = new GetObjectCommand({
          Bucket: Resource.fabFileBucket.name,
          Key: key,
        });

        const refreshedUrl = await getSignedUrl(s3Client, command, {
          expiresIn: this.URL_EXPIRY_SECONDS,
        });

        return refreshedUrl;
      }

      // Otherwise, process it as a new image
      return this.processModalImageUrl(oldUrl);
    } catch (error) {
      console.error('[ModalImageHandler] Error refreshing modal image URL:', error);
      return oldUrl;
    }
  }
}
