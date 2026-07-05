import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { createHash } from 'crypto';
import { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { z } from 'zod';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';

// Configuration constants
const CACHE_CONTROL_HEADER = 'max-age=300, must-revalidate'; // 5 minute cache
const MAX_RETRY_ATTEMPTS = 3;
const MANIFEST_KEY = 'manifest.json';

/**
 * Zod schema for What's New modal payload validation.
 * Exported for use by fork fetcher for schema validation.
 */
export const WhatsNewModalPayloadSchema = z.object({
  version: z.literal('1.0').optional().prefault('1.0'),
  modalId: z.string().min(1).max(100), // MongoDB ObjectId is 24 chars, allow some buffer
  title: z.string().min(1).max(200),
  subtitle: z.string().min(1).max(500),
  description: z.string().min(1).max(15000),
  generatedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  releaseTag: z.string().min(1).max(50).optional(),
  releases: z.array(z.string().min(1).max(50)).optional(),
  environment: z.enum(['dev', 'production']),
  createdAt: z.string().min(1),
  metadata: z.object({
    modelUsed: z.string().min(1).max(100),
    correlationId: z.string().min(1).max(100),
    repositoryUrl: z.url().min(1).max(500),
  }),
});

export type WhatsNewModalPayload = z.infer<typeof WhatsNewModalPayloadSchema>;

/**
 * Input type for uploadModal - version is optional (defaults to '1.0')
 */
export type WhatsNewModalPayloadInput = Omit<WhatsNewModalPayload, 'version'> & {
  version?: '1.0';
};

/**
 * Schema for individual modal entry in manifest.
 */
export const ManifestModalEntrySchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  generatedDate: z.string().optional(),
  releaseTag: z.string().optional(),
  title: z.string().min(1),
  contentHash: z.string().min(1), // SHA-256 hash for cache validation
  uploadedAt: z.string().min(1),
  // Soft delete fields (tombstone pattern)
  deleted: z.boolean().optional(),
  deletedAt: z.string().optional(),
});

export type ManifestModalEntry = z.infer<typeof ManifestModalEntrySchema>;

/**
 * Schema for the manifest.json file that lists all available modals.
 */
export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().min(1),
  lastUpdated: z.string().min(1),
  modals: z.array(ManifestModalEntrySchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Service for distributing What's New modals to fork environments via S3.
 *
 * Production Lambda uploads modal JSON to S3 bucket (via CloudFront CDN).
 * Fork environments fetch and import modals via scheduled cron.
 */
export class WhatsNewDistributionService {
  private static s3Client = new S3Client({});
  private static cfClient = new CloudFrontClient({});
  private static logger = new Logger({ metadata: { service: 'WhatsNewDistributionService' } });

  /**
   * Upload What's New modal JSON to S3 distribution bucket.
   * Only runs in production environment.
   *
   * @param payload - Modal data to upload (version defaults to '1.0')
   * @throws Error if S3 upload fails after retries
   */
  static async uploadModal(payload: WhatsNewModalPayloadInput): Promise<void> {
    // Only upload if this is the publisher (main production)
    // Fork environments should not upload - they consume via WHATS_NEW_DISTRIBUTION_URL
    if (process.env.ENABLE_WHATS_NEW_DISTRIBUTION !== 'true') {
      this.logger.info('Skipping S3 upload - ENABLE_WHATS_NEW_DISTRIBUTION not enabled (fork mode)');
      return;
    }

    // Only upload in production environment
    if (payload.environment !== 'production') {
      this.logger.info('Skipping S3 upload for non-production environment', {
        environment: payload.environment,
      });
      return;
    }

    const startTime = Date.now();
    // Note: Type assertion needed until sst-env.d.ts is regenerated after deploy
    const bucketResource = (Resource as unknown as { whatsNewDistributionBucket?: { name: string } })
      .whatsNewDistributionBucket;
    if (!bucketResource?.name) {
      throw new Error('whatsNewDistributionBucket not configured in SST resources');
    }
    const bucket = bucketResource.name;
    const content = JSON.stringify({ ...payload, version: '1.0' }, null, 2);
    const filename = payload.generatedDate || payload.releaseTag || 'unknown';

    try {
      // Upload archive first, then latest.json to prevent inconsistent state
      // If archive upload fails, latest.json won't reference missing content
      await this.uploadWithRetry(bucket, `production/${filename}.json`, content);
      await this.uploadWithRetry(bucket, 'latest.json', content);

      // Update manifest with new modal entry (for selective sync)
      await this.updateManifest(bucket, payload, content);

      const duration = Date.now() - startTime;
      this.logger.info('Modal uploaded to S3 distribution bucket', {
        modalId: payload.modalId,
        filename,
        duration,
        bucket,
      });

      // Emit success metrics
      await emitModalGenerationMetrics([
        {
          name: 'S3DistributionUploadSuccess',
          value: 1,
          dimensions: { environment: payload.environment },
        },
        {
          name: 'S3DistributionUploadLatency',
          value: duration,
          unit: StandardUnit.Milliseconds,
          dimensions: { environment: payload.environment },
        },
        {
          name: 'S3DistributionUploadSize',
          value: content.length,
          unit: StandardUnit.Bytes,
          dimensions: { environment: payload.environment },
        },
      ]);
    } catch (error) {
      this.logger.error('Failed to upload modal to S3 distribution bucket', {
        error: error instanceof Error ? error.message : String(error),
        modalId: payload.modalId,
        bucket,
      });

      // Emit failure metrics
      await emitModalGenerationMetrics([
        {
          name: 'S3DistributionUploadFailure',
          value: 1,
          dimensions: { environment: payload.environment },
        },
      ]);

      throw error;
    }
  }

  /**
   * Upload file to S3 with exponential backoff retry.
   */
  private static async uploadWithRetry(bucket: string, key: string, content: string): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.uploadFile(bucket, key, content);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`S3 upload attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed`, {
          key,
          error: lastError.message,
        });

        if (attempt < MAX_RETRY_ATTEMPTS) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Upload a single file to S3.
   */
  private static async uploadFile(bucket: string, key: string, content: string): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: 'application/json',
        CacheControl: CACHE_CONTROL_HEADER,
      })
    );
  }

  /**
   * Update the manifest.json with a new modal entry.
   * Fetches current manifest, adds/updates the modal entry, and uploads.
   *
   * @param bucket - S3 bucket name
   * @param payload - Modal payload to add to manifest
   * @param content - JSON content string (for content hash calculation)
   */
  static async updateManifest(bucket: string, payload: WhatsNewModalPayloadInput, content: string): Promise<void> {
    try {
      // Fetch current manifest or create empty one
      let manifest = await this.fetchManifest(bucket);

      const filename = payload.generatedDate || payload.releaseTag || 'unknown';
      const key = `production/${filename}.json`;
      const contentHash = this.calculateContentHash(content);

      // Create new modal entry
      const newEntry: ManifestModalEntry = {
        id: payload.modalId,
        key,
        generatedDate: payload.generatedDate,
        releaseTag: payload.releaseTag,
        title: payload.title,
        contentHash,
        uploadedAt: new Date().toISOString(),
      };

      // Check if modal already exists (by id or key) and update, otherwise add
      const existingIndex = manifest.modals.findIndex(m => m.id === payload.modalId || m.key === key);

      if (existingIndex >= 0) {
        // Update existing entry
        manifest.modals[existingIndex] = newEntry;
        this.logger.info('Updated existing modal in manifest', { modalId: payload.modalId, key });
      } else {
        // Add new entry at the beginning (most recent first)
        manifest.modals.unshift(newEntry);
        this.logger.info('Added new modal to manifest', { modalId: payload.modalId, key });
      }

      // Update manifest metadata
      manifest = {
        ...manifest,
        version: this.incrementVersion(manifest.version),
        lastUpdated: new Date().toISOString(),
      };

      // Upload updated manifest
      const manifestContent = JSON.stringify(manifest, null, 2);
      await this.uploadWithRetry(bucket, MANIFEST_KEY, manifestContent);

      this.logger.info('Manifest updated successfully', {
        version: manifest.version,
        totalModals: manifest.modals.length,
      });
    } catch (error) {
      this.logger.error('Failed to update manifest', {
        error: error instanceof Error ? error.message : String(error),
        modalId: payload.modalId,
      });
      // Don't throw - manifest update is supplementary to modal upload
      // The modal is still usable via latest.json even if manifest fails
    }
  }

  /**
   * Fetch current manifest from S3, or return empty manifest if not found.
   */
  private static async fetchManifest(bucket: string): Promise<Manifest> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: MANIFEST_KEY,
        })
      );

      const bodyString = await response.Body?.transformToString();
      if (!bodyString) {
        return this.createEmptyManifest();
      }

      const parsed = JSON.parse(bodyString);
      const validated = ManifestSchema.safeParse(parsed);

      if (!validated.success) {
        this.logger.warn('Invalid manifest schema, creating new manifest', {
          errors: validated.error.issues,
        });
        return this.createEmptyManifest();
      }

      return validated.data;
    } catch (error) {
      // If manifest doesn't exist (404), create empty one
      if (error instanceof Error && 'name' in error && error.name === 'NoSuchKey') {
        this.logger.info('Manifest not found, creating new one');
        return this.createEmptyManifest();
      }
      throw error;
    }
  }

  /**
   * Create an empty manifest structure.
   */
  private static createEmptyManifest(): Manifest {
    return {
      schemaVersion: 1,
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      modals: [],
    };
  }

  /**
   * Calculate SHA-256 content hash for cache validation.
   */
  private static calculateContentHash(content: string): string {
    return `sha256:${createHash('sha256').update(content).digest('hex')}`;
  }

  /**
   * Increment semantic version string (e.g., "1.0.0" -> "1.0.1").
   */
  private static incrementVersion(version: string): string {
    const parts = version.split('.');
    if (parts.length !== 3) return '1.0.1';

    const patch = parseInt(parts[2], 10);
    if (isNaN(patch)) return '1.0.1';

    parts[2] = String(patch + 1);
    return parts.join('.');
  }

  /**
   * Get the S3 bucket name for distribution.
   * Returns undefined if not configured.
   */
  private static getBucket(): string | undefined {
    const bucketResource = (Resource as unknown as { whatsNewDistributionBucket?: { name: string } })
      .whatsNewDistributionBucket;
    return bucketResource?.name;
  }

  /**
   * Get the CloudFront distribution ID for cache invalidation.
   * Returns undefined if not configured.
   */
  private static getDistributionId(): string | undefined {
    const distributionResource = (Resource as unknown as { whatsNewDistributionId?: { value: string } })
      .whatsNewDistributionId;
    return distributionResource?.value;
  }

  /**
   * Check if this is the source environment (main production).
   */
  private static isSourceEnvironment(): boolean {
    return process.env.ENABLE_WHATS_NEW_DISTRIBUTION === 'true';
  }

  /**
   * Update an existing modal in S3 distribution.
   * Only runs in source environment.
   *
   * @param modalId - The modal ID to update
   * @param key - The S3 key (e.g., "production/2025-01-22.json")
   * @param content - The updated JSON content
   * @param title - The modal title (for manifest update)
   */
  static async updateExistingModal(modalId: string, key: string, content: string, title: string): Promise<void> {
    if (!this.isSourceEnvironment()) {
      this.logger.info('Skipping S3 update - not source environment');
      return;
    }

    const bucket = this.getBucket();
    if (!bucket) {
      this.logger.warn('Cannot update modal - distribution bucket not configured');
      return;
    }

    const startTime = Date.now();

    try {
      // Upload updated modal content
      await this.uploadWithRetry(bucket, key, content);

      // Check if this is the latest modal and update latest.json if so
      const manifest = await this.fetchManifest(bucket);
      const latestModal = manifest.modals.find(m => !m.deleted);
      if (latestModal?.id === modalId) {
        await this.uploadWithRetry(bucket, 'latest.json', content);
        this.logger.info('Updated latest.json with edited modal', { modalId });
      }

      // Update manifest entry with new content hash
      const contentHash = this.calculateContentHash(content);
      const entryIndex = manifest.modals.findIndex(m => m.id === modalId);
      if (entryIndex >= 0) {
        manifest.modals[entryIndex] = {
          ...manifest.modals[entryIndex],
          title,
          contentHash,
          uploadedAt: new Date().toISOString(),
        };
        manifest.version = this.incrementVersion(manifest.version);
        manifest.lastUpdated = new Date().toISOString();
        await this.uploadWithRetry(bucket, MANIFEST_KEY, JSON.stringify(manifest, null, 2));
      }

      // Invalidate CloudFront cache
      const pathsToInvalidate = [`/${key}`, '/manifest.json'];
      if (latestModal?.id === modalId) {
        pathsToInvalidate.push('/latest.json');
      }
      await this.invalidateCloudFrontPaths(pathsToInvalidate);

      const duration = Date.now() - startTime;
      this.logger.info('Modal updated in S3 distribution', {
        modalId,
        key,
        duration,
      });

      // Emit success metrics
      await emitModalGenerationMetrics([
        {
          name: 'S3DistributionUpdateSuccess',
          value: 1,
          dimensions: { environment: 'production' },
        },
        {
          name: 'S3DistributionUpdateLatency',
          value: duration,
          unit: StandardUnit.Milliseconds,
          dimensions: { environment: 'production' },
        },
      ]);
    } catch (error) {
      this.logger.error('Failed to update modal in S3 distribution', {
        error: error instanceof Error ? error.message : String(error),
        modalId,
        key,
      });

      // Emit failure metrics
      await emitModalGenerationMetrics([
        {
          name: 'S3DistributionUpdateFailure',
          value: 1,
          dimensions: { environment: 'production' },
        },
      ]);

      throw error;
    }
  }

  /**
   * Delete a modal from S3 distribution (soft delete in manifest, hard delete from S3).
   * Only runs in source environment.
   *
   * @param modalId - The modal ID to delete
   * @param key - The S3 key (e.g., "production/2025-01-22.json")
   */
  static async deleteModal(modalId: string, key: string): Promise<void> {
    if (!this.isSourceEnvironment()) {
      this.logger.info('Skipping S3 delete - not source environment');
      return;
    }

    const bucket = this.getBucket();
    if (!bucket) {
      this.logger.warn('Cannot delete modal - distribution bucket not configured');
      return;
    }

    const startTime = Date.now();

    try {
      // Fetch manifest ONCE to avoid TOCTOU race conditions
      const manifest = await this.fetchManifest(bucket);
      const latestModal = manifest.modals.find(m => !m.deleted);
      const isLatest = latestModal?.id === modalId;

      // Soft delete in manifest (tombstone pattern) - mutates manifest in place
      const updatedManifest = this.applyManifestSoftDelete(manifest, modalId);

      // Upload the updated manifest
      await this.uploadWithRetry(bucket, MANIFEST_KEY, JSON.stringify(updatedManifest, null, 2));
      this.logger.info('Modal soft-deleted from manifest', { modalId });

      // Hard delete the S3 object (versioning preserves it for recovery)
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      this.logger.info('Deleted modal from S3', { modalId, key });

      // If this was the latest, update latest.json to next available modal
      // Use the already-updated manifest to find the next latest
      if (isLatest) {
        await this.updateLatestFromManifest(bucket, updatedManifest);
      }

      // Invalidate CloudFront cache
      const pathsToInvalidate = ['/manifest.json'];
      if (isLatest) {
        pathsToInvalidate.push('/latest.json');
      }
      await this.invalidateCloudFrontPaths(pathsToInvalidate);

      const duration = Date.now() - startTime;
      this.logger.info('Modal deleted from S3 distribution', {
        modalId,
        key,
        duration,
        wasLatest: isLatest,
      });

      // Emit success metrics
      await emitModalGenerationMetrics([
        {
          name: 'S3DistributionDeleteSuccess',
          value: 1,
          dimensions: { environment: 'production' },
        },
        {
          name: 'S3DistributionDeleteLatency',
          value: duration,
          unit: StandardUnit.Milliseconds,
          dimensions: { environment: 'production' },
        },
      ]);
    } catch (error) {
      this.logger.error('Failed to delete modal from S3 distribution', {
        error: error instanceof Error ? error.message : String(error),
        modalId,
        key,
      });

      // Emit failure metrics
      await emitModalGenerationMetrics([
        {
          name: 'S3DistributionDeleteFailure',
          value: 1,
          dimensions: { environment: 'production' },
        },
      ]);

      throw error;
    }
  }

  /**
   * Apply soft delete to a manifest entry (pure function).
   * Returns the updated manifest without re-fetching.
   *
   * @param manifest - The manifest to update
   * @param modalId - The modal ID to soft-delete
   * @returns Updated manifest with the modal marked as deleted
   */
  private static applyManifestSoftDelete(manifest: Manifest, modalId: string): Manifest {
    const entryIndex = manifest.modals.findIndex(m => m.id === modalId);

    if (entryIndex < 0) {
      this.logger.warn('Modal not found in manifest for soft delete', { modalId });
      return manifest;
    }

    // Create a new manifest with the entry marked as deleted (tombstone)
    const updatedModals = [...manifest.modals];
    updatedModals[entryIndex] = {
      ...updatedModals[entryIndex],
      deleted: true,
      deletedAt: new Date().toISOString(),
    };

    return {
      ...manifest,
      modals: updatedModals,
      version: this.incrementVersion(manifest.version),
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Update latest.json based on the provided manifest.
   * Uses the manifest passed in to avoid re-fetching and TOCTOU issues.
   *
   * @param bucket - S3 bucket name
   * @param manifest - The current manifest (already updated)
   */
  private static async updateLatestFromManifest(bucket: string, manifest: Manifest): Promise<void> {
    // Find the next non-deleted modal (sorted by date, newest first)
    const nextLatest = manifest.modals.find(m => !m.deleted);

    if (!nextLatest) {
      // No more modals - upload empty latest.json
      const emptyLatest = {
        version: '1.0',
        modalId: '',
        title: '',
        subtitle: '',
        description: '',
        environment: 'production',
        createdAt: new Date().toISOString(),
        metadata: {
          modelUsed: 'none',
          correlationId: 'deleted',
          repositoryUrl: 'https://github.com/MillionOnMars/lumina5',
        },
        _deleted: true, // Flag indicating no active modal
      };
      await this.uploadWithRetry(bucket, 'latest.json', JSON.stringify(emptyLatest, null, 2));
      this.logger.info('Set latest.json to empty state (no active modals)');
      return;
    }

    // Fetch the next latest modal content from S3
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: nextLatest.key,
        })
      );

      const content = await response.Body?.transformToString();
      if (content) {
        await this.uploadWithRetry(bucket, 'latest.json', content);
        this.logger.info('Updated latest.json to next available modal', {
          modalId: nextLatest.id,
          key: nextLatest.key,
        });
      }
    } catch (error) {
      this.logger.error('Failed to update latest.json after delete', {
        error: error instanceof Error ? error.message : String(error),
        nextModalId: nextLatest.id,
      });
      // Don't throw - the delete operation itself succeeded
    }
  }

  /**
   * Invalidate CloudFront cache for specified paths.
   * Non-critical - failures are logged but don't throw.
   */
  private static async invalidateCloudFrontPaths(paths: string[]): Promise<void> {
    const distributionId = this.getDistributionId();
    if (!distributionId) {
      this.logger.info('Skipping CloudFront invalidation - distribution ID not configured');
      return;
    }

    try {
      await this.cfClient.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: {
            CallerReference: `whats-new-${Date.now()}`,
            Paths: {
              Quantity: paths.length,
              Items: paths.map(p => (p.startsWith('/') ? p : `/${p}`)),
            },
          },
        })
      );
      this.logger.info('CloudFront cache invalidated', { paths });
    } catch (error) {
      this.logger.warn('Failed to invalidate CloudFront cache', {
        error: error instanceof Error ? error.message : String(error),
        paths,
      });
      // Don't throw - cache invalidation is non-critical
    }
  }
}
