import axios from 'axios';
import axiosRetry from 'axios-retry';
import { createHash } from 'crypto';
import { Resource } from 'sst';
import { Logger } from '@bike4mind/observability';
import { IModalDocument, WhatsNewSyncConfigSchema } from '@bike4mind/common';
import { ModalModel, AdminSettings } from '@bike4mind/database';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';
import {
  WhatsNewModalPayloadSchema,
  WhatsNewModalPayload,
  ManifestSchema,
  Manifest,
  ManifestModalEntry,
} from './whatsNewDistribution';

// Configuration constants
const WHATS_NEW_TAG = 'whats-new' as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MODAL_EXPIRY_DAYS = 30;
const HTTP_TIMEOUT_MS = 30000; // 30 seconds for large payloads
const SETTING_NAME = 'whatsNewSyncConfig' as const;

/**
 * Allowed domains for distribution URL to prevent SSRF attacks.
 * Only CloudFront, S3, and the deployment's own custom domain are permitted.
 * Domains are prefixed with '.' to indicate subdomain matching.
 *
 * The custom production domain is NOT hardcoded - it is the account-tied deployment domain
 * sourced from SERVER_DOMAIN with no brand fallback. See getAllowedDistributionDomains().
 */
const ALLOWED_DISTRIBUTION_DOMAINS = [
  // CloudFront
  '.cloudfront.net',
  // S3 global endpoint
  '.s3.amazonaws.com',
  // S3 regional endpoints - US
  '.s3.us-east-1.amazonaws.com',
  '.s3.us-east-2.amazonaws.com',
  '.s3.us-west-1.amazonaws.com',
  '.s3.us-west-2.amazonaws.com',
  // S3 regional endpoints - Europe
  '.s3.eu-west-1.amazonaws.com',
  '.s3.eu-west-2.amazonaws.com',
  '.s3.eu-west-3.amazonaws.com',
  '.s3.eu-central-1.amazonaws.com',
  '.s3.eu-north-1.amazonaws.com',
  '.s3.eu-south-1.amazonaws.com',
  // S3 regional endpoints - Asia Pacific
  '.s3.ap-southeast-1.amazonaws.com',
  '.s3.ap-southeast-2.amazonaws.com',
  '.s3.ap-northeast-1.amazonaws.com',
  '.s3.ap-northeast-2.amazonaws.com',
  '.s3.ap-northeast-3.amazonaws.com',
  '.s3.ap-south-1.amazonaws.com',
  // S3 regional endpoints - Other
  '.s3.sa-east-1.amazonaws.com',
  '.s3.ca-central-1.amazonaws.com',
  '.s3.me-south-1.amazonaws.com',
  '.s3.af-south-1.amazonaws.com',
];

/**
 * Parse a comma-separated host-suffix list into normalized allowlist entries. Each entry is
 * lowercased and prefixed with '.' so it matches the subdomain-matching format used by
 * {@link isAllowedHostname} (e.g. `feed.upstream.example` -> `.feed.upstream.example`).
 */
function parseAllowedDistributionHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map(host => (host.startsWith('.') ? host : `.${host}`));
}

/**
 * Full SSRF allowlist for distribution URLs: the static CloudFront/S3 endpoints, the
 * account-tied deployment domain (SERVER_DOMAIN, no brand fallback), and any
 * operator-configured upstream distribution host(s) (WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS).
 *
 * The configurable upstream host lets a fork pull the upstream What's New feed from a custom
 * domain - one that isn't CloudFront/S3 and isn't the fork's own SERVER_DOMAIN - without
 * re-hardcoding a brand literal. Empty by default; when neither SERVER_DOMAIN nor the
 * override is set, only CloudFront/S3 are permitted.
 */
function getAllowedDistributionDomains(): string[] {
  const domains = [...ALLOWED_DISTRIBUTION_DOMAINS];
  const serverDomain = process.env.SERVER_DOMAIN;
  if (serverDomain) domains.unshift(`.${serverDomain}`);
  domains.push(...parseAllowedDistributionHosts(process.env.WHATS_NEW_ALLOWED_DISTRIBUTION_HOSTS));
  return domains;
}

/**
 * Check if a hostname matches an allowed domain.
 * Supports both exact domain match and subdomain match.
 *
 * @example
 * isAllowedHostname('abc123.cloudfront.net', '.cloudfront.net') // true (subdomain)
 * isAllowedHostname('cloudfront.net', '.cloudfront.net') // true (exact match)
 * isAllowedHostname('evilcloudfront.net', '.cloudfront.net') // false (not a subdomain)
 * isAllowedHostname('evil.cloudfront.net.attacker.com', '.cloudfront.net') // false
 */
function isAllowedHostname(hostname: string, allowedDomain: string): boolean {
  // allowedDomain starts with '.' (e.g., '.cloudfront.net')
  const baseDomain = allowedDomain.slice(1); // Remove leading dot -> 'cloudfront.net'

  // Exact match: hostname === 'cloudfront.net'
  if (hostname === baseDomain) {
    return true;
  }

  // Subdomain match: hostname ends with '.cloudfront.net' (including the dot)
  // This ensures 'evilcloudfront.net' doesn't match '.cloudfront.net'
  if (hostname.endsWith(allowedDomain)) {
    return true;
  }

  return false;
}

/**
 * Validate that a URL is safe to use as distribution URL.
 * - Must be HTTPS
 * - Must be on an allowed domain (CloudFront/S3)
 *
 * @param url - URL to validate
 * @returns Validation result with error message if invalid
 */
export function validateDistributionUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Must be HTTPS
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'URL must use HTTPS' };
    }

    // Check against allowlist using secure domain matching
    const isAllowedDomain = getAllowedDistributionDomains().some(domain => isAllowedHostname(parsed.hostname, domain));
    if (!isAllowedDomain) {
      return {
        valid: false,
        error:
          'Domain not allowed. Must be a CloudFront, S3, the configured deployment domain, or a configured upstream distribution host.',
      };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

// Per-invocation cache for distribution URL (prevents race conditions during sync)
let cachedDistributionUrl: string | null = null;

/**
 * Clear cached distribution URL.
 * Call at start of sync operations to ensure fresh lookup.
 */
export function clearDistributionUrlCache(): void {
  cachedDistributionUrl = null;
}

/**
 * Get the distribution URL, checking admin override first, then SST secret.
 * Returns a cached URL for the duration of the sync operation to prevent race conditions.
 *
 * SECURITY: URLs are validated against domain allowlist (CloudFront/S3 only).
 */
async function getDistributionUrl(): Promise<string> {
  // Return cached URL if available (per-invocation caching)
  if (cachedDistributionUrl) {
    return cachedDistributionUrl;
  }

  const logger = new Logger({ metadata: { service: 'WhatsNewForkFetcher' } });

  // 1. Check admin setting override first
  const setting = await AdminSettings.findOne({ settingName: SETTING_NAME });
  if (setting?.settingValue) {
    const config = WhatsNewSyncConfigSchema.safeParse(setting.settingValue);
    if (config.success && config.data.distributionUrlOverride) {
      const validation = validateDistributionUrl(config.data.distributionUrlOverride);
      if (validation.valid) {
        cachedDistributionUrl = config.data.distributionUrlOverride;
        logger.info('Using admin override for distribution URL');
        return cachedDistributionUrl;
      }
      // Invalid override - log warning and fall through
      logger.warn('Invalid distributionUrlOverride, falling back to SST secret', {
        error: validation.error,
      });
    }
  }

  // 2. Fall back to SST Secret
  const url = Resource.WHATS_NEW_DISTRIBUTION_URL?.value;
  if (!url || url === 'not-configured') {
    throw new Error(
      'Distribution URL is not configured. ' +
        "Set it in Admin → Modals → What's New Modals (Sync Configuration section), " +
        'or configure WHATS_NEW_DISTRIBUTION_URL SST secret.'
    );
  }

  const validation = validateDistributionUrl(url);
  if (!validation.valid) {
    throw new Error(`Invalid WHATS_NEW_DISTRIBUTION_URL: ${validation.error}`);
  }

  cachedDistributionUrl = url;
  return cachedDistributionUrl;
}

// Configure axios client with retry
const client = axios.create({ timeout: HTTP_TIMEOUT_MS });
axiosRetry(client, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: error =>
    axiosRetry.isNetworkOrIdempotentRequestError(error) ||
    error.response?.status === 503 ||
    error.response?.status === 502,
});

export interface ForkFetchResult {
  imported: boolean;
  reason: string;
  modalId?: string;
  generatedDate?: string;
}

/**
 * Result of syncing existing modals (updates and deletions).
 */
export interface SyncExistingResult {
  updated: number;
  deleted: number;
  upToDate: number;
  errors: string[];
}

/**
 * Service for fetching and importing What's New modals from production.
 * Only runs in non-production environments (dev, staging, forks).
 */
export class WhatsNewForkFetcher {
  private static logger = new Logger({ metadata: { service: 'WhatsNewForkFetcher' } });

  /**
   * Fetch and import latest What's New modal from production S3.
   * Only runs in fork/non-production environments.
   *
   * @returns Result indicating whether import succeeded and why
   */
  static async fetchAndImportLatest(): Promise<ForkFetchResult> {
    // Clear distribution URL cache at start of sync operation
    clearDistributionUrlCache();

    const startTime = Date.now();
    const stage = Resource.App.stage;

    // Only run in fork/non-production environments
    if (stage === 'production') {
      this.logger.info('Skipping fork fetch - running in production environment');
      return { imported: false, reason: 'Production environment - skipping' };
    }

    try {
      // 1. Fetch latest modal JSON from production S3
      const modalData = await this.fetchLatestModal();
      if (!modalData) {
        await this.emitSkipMetric('no_modal_available', stage);
        return { imported: false, reason: 'No modal available from production' };
      }

      // 2. Check for duplicates (already imported)
      const isDuplicate = await this.checkDuplicate(modalData);
      if (isDuplicate) {
        await this.emitSkipMetric('duplicate', stage);
        return {
          imported: false,
          reason: `Modal ${modalData.generatedDate || modalData.modalId} already exists`,
          generatedDate: modalData.generatedDate,
        };
      }

      // 3. Fetch manifest to get contentHash for the imported modal
      const manifest = await this.fetchManifest();
      const manifestEntry = manifest?.modals.find(m => m.id === modalData.modalId);
      const sourceContentHash = manifestEntry?.contentHash;

      // 4. Import modal into local database with content hash for future sync
      const importedModal = await this.importModal(modalData, stage, sourceContentHash);

      // Emit success metrics
      const duration = Date.now() - startTime;
      await emitModalGenerationMetrics([
        { name: 'ForkImportSuccess', value: 1, dimensions: { stage } },
        { name: 'ForkImportLatency', value: duration, unit: StandardUnit.Milliseconds, dimensions: { stage } },
      ]);

      this.logger.info("Successfully imported What's New modal from production", {
        sourceModalId: modalData.modalId,
        localModalId: importedModal._id?.toString(),
        generatedDate: modalData.generatedDate,
      });

      return {
        imported: true,
        reason: `Imported modal ${modalData.generatedDate || modalData.modalId}`,
        modalId: importedModal._id?.toString(),
        generatedDate: modalData.generatedDate,
      };
    } catch (error) {
      // Handle race condition: concurrent imports may result in duplicate key error
      // MongoDB error code 11000 = duplicate key error
      const isDuplicateKeyError =
        error instanceof Error && 'code' in error && (error as { code: number }).code === 11000;

      if (isDuplicateKeyError) {
        this.logger.info('Concurrent import detected - modal already exists', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.emitSkipMetric('concurrent_duplicate', stage);
        return {
          imported: false,
          reason: 'Modal already imported by concurrent process',
        };
      }

      this.logger.error("Failed to fetch/import What's New modal from production", {
        error: error instanceof Error ? error.message : String(error),
      });

      await emitModalGenerationMetrics([{ name: 'ForkImportFailure', value: 1, dimensions: { stage } }]);

      throw error;
    }
  }

  /**
   * Emit skip metric with reason.
   */
  private static async emitSkipMetric(reason: string, stage: string): Promise<void> {
    await emitModalGenerationMetrics([{ name: 'ForkImportSkipped', value: 1, dimensions: { reason, stage } }]);
  }

  /**
   * Fetch latest modal JSON from production S3 via CloudFront.
   */
  private static async fetchLatestModal(): Promise<WhatsNewModalPayload | null> {
    const distributionUrl = await getDistributionUrl();
    const url = `${distributionUrl}/latest.json`;

    try {
      this.logger.info('Fetching latest modal from production', { url });
      const response = await client.get(url);

      // Check if latest.json indicates no active modals (all deleted)
      if (response.data?._deleted === true) {
        this.logger.info('Latest modal marked as deleted (no active modals in production)');
        return null;
      }

      // Validate schema before returning (security: prevent malformed data)
      // Note: axios throws on non-2xx by default, so we only reach here on success
      const validated = WhatsNewModalPayloadSchema.parse(response.data);
      this.logger.info('Successfully fetched and validated modal', {
        modalId: validated.modalId,
        generatedDate: validated.generatedDate,
      });
      return validated;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.logger.info('No modal found at distribution URL (404)', { url });
        return null;
      }
      throw error;
    }
  }

  /**
   * Check if modal already exists in local database.
   */
  private static async checkDuplicate(modalData: WhatsNewModalPayload): Promise<boolean> {
    // Check by sourceModalId (most reliable)
    const existingBySourceId = await ModalModel.findOne({
      'generationMetadata.sourceModalId': modalData.modalId,
    });
    if (existingBySourceId) {
      this.logger.info('Modal already exists by sourceModalId', { sourceModalId: modalData.modalId });
      return true;
    }

    // Fallback: check by generatedDate
    if (modalData.generatedDate) {
      const existingByDate = await ModalModel.findOne({
        'generationMetadata.generatedDate': modalData.generatedDate,
      });
      if (existingByDate) {
        this.logger.info('Modal already exists by generatedDate', { generatedDate: modalData.generatedDate });
        return true;
      }
    }

    return false;
  }

  /**
   * Import modal into local database.
   *
   * @param modalData - Modal data from production S3
   * @param stage - Current environment stage
   * @param sourceContentHash - Content hash from manifest for edit detection during sync
   */
  private static async importModal(
    modalData: WhatsNewModalPayload,
    stage: string,
    sourceContentHash?: string
  ): Promise<IModalDocument> {
    const startDate = new Date();
    const endDate = new Date(Date.now() + MODAL_EXPIRY_DAYS * MS_PER_DAY);

    const createdModals = await ModalModel.create([
      {
        title: modalData.title,
        subtitle: modalData.subtitle,
        description: modalData.description,
        tags: [WHATS_NEW_TAG, 'imported-from-production'],
        priority: 10,
        closeButton: true,
        agreeButton: true,
        enabled: true,
        isBanner: false,
        startDate,
        endDate,
        // Set createdAt to generation date so sorting matches displayed dates
        createdAt: modalData.generatedDate ? new Date(modalData.generatedDate + 'T00:00:00Z') : new Date(),
        numberOfViews: {
          type: 'firstTimeView',
          value: 0,
          threshold: 1,
          tags: [WHATS_NEW_TAG],
        },
        generationMetadata: {
          sourceModalId: modalData.modalId, // Track source for deduplication
          sourceContentHash, // Track content hash for edit detection
          generatedDate: modalData.generatedDate,
          releaseTag: modalData.releaseTag,
          releases: modalData.releases,
          generatedAt: new Date(),
          correlationId: modalData.metadata.correlationId,
          modelUsed: modalData.metadata.modelUsed,
          environment: stage,
          importedFrom: 'production',
        },
      },
    ]);

    return createdModals[0];
  }

  /**
   * List all available modals from production S3 manifest.
   * Returns manifest entries with import status for each modal.
   *
   * @returns List of available modals with import status
   */
  static async listAvailableModals(): Promise<AvailableModalEntry[]> {
    const stage = Resource.App.stage;

    // Only run in fork/non-production environments
    if (stage === 'production') {
      this.logger.info('Skipping list available modals - running in production environment');
      return [];
    }

    try {
      // Fetch manifest from S3
      const manifest = await this.fetchManifest();
      if (!manifest || manifest.modals.length === 0) {
        this.logger.info('No modals available in manifest');
        return [];
      }

      // Get all imported source modal IDs for status checking
      const importedModals = await ModalModel.find(
        { 'generationMetadata.sourceModalId': { $exists: true } },
        { 'generationMetadata.sourceModalId': 1, 'generationMetadata.generatedDate': 1 }
      ).lean();

      const importedSourceIds = new Set(importedModals.map(m => m.generationMetadata?.sourceModalId).filter(Boolean));
      const importedDates = new Set(importedModals.map(m => m.generationMetadata?.generatedDate).filter(Boolean));

      // Filter out deleted entries (soft delete tombstones) and map to available modal entries
      const activeManifestEntries = manifest.modals.filter(entry => !entry.deleted);

      const availableModals: AvailableModalEntry[] = activeManifestEntries.map(entry => {
        const isImported = importedSourceIds.has(entry.id) || importedDates.has(entry.generatedDate);
        return {
          ...entry,
          status: isImported ? 'imported' : 'available',
        };
      });

      // Sort by generatedDate descending (newest first)
      // Manifest order is unreliable after parallel backfill inserts
      availableModals.sort((a, b) => (b.generatedDate || '').localeCompare(a.generatedDate || ''));

      this.logger.info('Listed available modals from manifest', {
        total: manifest.modals.length,
        deleted: manifest.modals.length - activeManifestEntries.length,
        active: activeManifestEntries.length,
        imported: availableModals.filter(m => m.status === 'imported').length,
        available: availableModals.filter(m => m.status === 'available').length,
      });

      return availableModals;
    } catch (error) {
      this.logger.error('Failed to list available modals', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Import a specific modal by its S3 key.
   *
   * @param key - S3 key of the modal to import (e.g., "production/2025-12-29.json")
   * @returns Import result with status and modal details
   */
  static async importModalByKey(key: string): Promise<ImportModalResult> {
    const stage = Resource.App.stage;

    // Only run in fork/non-production environments
    if (stage === 'production') {
      return {
        success: false,
        key,
        reason: 'Cannot import modals in production environment',
      };
    }

    try {
      const distributionUrl = await getDistributionUrl();
      const url = `${distributionUrl}/${key}`;

      this.logger.info('Fetching modal by key', { key, url });

      const response = await client.get(url);
      const validated = WhatsNewModalPayloadSchema.parse(response.data);

      // Check for duplicates
      const isDuplicate = await this.checkDuplicate(validated);
      if (isDuplicate) {
        return {
          success: false,
          key,
          modalId: validated.modalId,
          reason: 'Modal already imported',
        };
      }

      // Fetch manifest to get contentHash for the imported modal
      const manifest = await this.fetchManifest();
      const manifestEntry = manifest?.modals.find(m => m.key === key);
      const sourceContentHash = manifestEntry?.contentHash;

      // Import the modal with content hash for future sync
      const importedModal = await this.importModal(validated, stage, sourceContentHash);

      // Emit success metric
      await emitModalGenerationMetrics([{ name: 'ForkSelectiveImportSuccess', value: 1, dimensions: { stage } }]);

      return {
        success: true,
        key,
        modalId: importedModal._id?.toString(),
        generatedDate: validated.generatedDate,
        title: validated.title,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Handle 404 - modal not found
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return {
          success: false,
          key,
          reason: 'Modal not found at specified key',
        };
      }

      this.logger.error('Failed to import modal by key', { key, error: errorMessage });

      await emitModalGenerationMetrics([{ name: 'ForkSelectiveImportFailure', value: 1, dimensions: { stage } }]);

      return {
        success: false,
        key,
        reason: errorMessage,
      };
    }
  }

  /**
   * Sync updates and deletions for already-imported modals.
   * - Detects edited modals by comparing contentHash
   * - Deletes local copies of tombstoned modals
   *
   * Only runs in fork/non-production environments.
   *
   * @returns Summary of sync operations performed
   */
  static async syncExistingModals(): Promise<SyncExistingResult> {
    // Clear distribution URL cache at start of sync operation
    clearDistributionUrlCache();

    const stage = Resource.App.stage;

    // Only run in fork/non-production environments
    if (stage === 'production') {
      this.logger.info('Skipping sync existing modals - running in production environment');
      return { updated: 0, deleted: 0, upToDate: 0, errors: [] };
    }

    const result: SyncExistingResult = { updated: 0, deleted: 0, upToDate: 0, errors: [] };

    try {
      // 1. Fetch manifest from production S3
      const manifest = await this.fetchManifest();
      if (!manifest) {
        this.logger.warn('Cannot sync existing modals - manifest not available');
        result.errors.push('Manifest not available');
        return result;
      }

      // 2. Get all imported modals (have sourceModalId and importedFrom: 'production')
      const importedModals = await ModalModel.find({
        'generationMetadata.sourceModalId': { $exists: true },
        'generationMetadata.importedFrom': 'production',
      });

      if (importedModals.length === 0) {
        this.logger.info('No imported modals to sync');
        return result;
      }

      // 3. Build lookup map from manifest
      const manifestBySourceId = new Map(manifest.modals.map(m => [m.id, m]));

      // 4. Process each imported modal
      for (const localModal of importedModals) {
        const sourceId = localModal.generationMetadata?.sourceModalId;
        if (!sourceId) continue;

        const manifestEntry = manifestBySourceId.get(sourceId);

        if (!manifestEntry) {
          // Modal no longer in manifest - skip (may have been hard-deleted)
          this.logger.info('Skipping modal not found in manifest', { sourceId });
          continue;
        }

        try {
          // Check for deletion (tombstone)
          if (manifestEntry.deleted) {
            const deleteResult = await ModalModel.findByIdAndDelete(localModal._id);
            if (deleteResult) {
              result.deleted++;
              this.logger.info('Deleted local modal (production deleted)', {
                localModalId: localModal._id?.toString(),
                sourceId,
              });
            } else {
              this.logger.warn('Modal already deleted or not found', {
                localModalId: localModal._id?.toString(),
                sourceId,
              });
            }
            continue;
          }

          // Check for edit (contentHash mismatch) or missing hash (pre-migration backfill)
          const localHash = localModal.generationMetadata?.sourceContentHash;
          if (!localHash || localHash !== manifestEntry.contentHash) {
            // Fetch updated content and apply
            await this.updateLocalModal(localModal, manifestEntry);
            result.updated++;
          } else {
            result.upToDate++;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push(`Failed to sync modal ${sourceId}: ${errorMessage}`);
          this.logger.error('Failed to sync individual modal', { sourceId, error: errorMessage });
        }
      }

      this.logger.info('Completed sync of existing modals', {
        updated: result.updated,
        deleted: result.deleted,
        upToDate: result.upToDate,
        errors: result.errors.length,
      });

      // Emit batched metrics (single CloudWatch call instead of per-modal)
      const metricsToEmit = [];
      if (result.updated > 0) {
        metricsToEmit.push({ name: 'ForkSyncUpdateSuccess', value: result.updated, dimensions: { stage } });
      }
      if (result.deleted > 0) {
        metricsToEmit.push({ name: 'ForkSyncDeleteSuccess', value: result.deleted, dimensions: { stage } });
      }
      if (result.upToDate > 0) {
        metricsToEmit.push({ name: 'ForkSyncSkipped', value: result.upToDate, dimensions: { stage } });
      }
      if (result.errors.length > 0) {
        metricsToEmit.push({ name: 'ForkSyncError', value: result.errors.length, dimensions: { stage } });
      }
      if (metricsToEmit.length > 0) {
        await emitModalGenerationMetrics(metricsToEmit);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to sync existing modals', { error: errorMessage });
      result.errors.push(`Sync failed: ${errorMessage}`);
      return result;
    }
  }

  /**
   * Update a local modal with content from production S3.
   * Includes hash verification to prevent MITM attacks.
   *
   * @param localModal - The local modal document to update
   * @param manifestEntry - The manifest entry with the updated content info
   */
  private static async updateLocalModal(localModal: IModalDocument, manifestEntry: ManifestModalEntry): Promise<void> {
    const distributionUrl = await getDistributionUrl();
    const url = `${distributionUrl}/${manifestEntry.key}`;

    const response = await client.get(url);

    // Security: Verify content hash before applying update to prevent MITM attacks
    const fetchedContent = JSON.stringify(response.data, null, 2);
    const calculatedHash = `sha256:${createHash('sha256').update(fetchedContent).digest('hex')}`;

    if (calculatedHash !== manifestEntry.contentHash) {
      this.logger.error('Content hash mismatch - possible tampering', {
        expected: manifestEntry.contentHash,
        actual: calculatedHash,
        modalId: manifestEntry.id,
      });
      throw new Error(`Content hash mismatch for modal ${manifestEntry.id}`);
    }

    const validated = WhatsNewModalPayloadSchema.parse(response.data);

    // Update local modal with new content
    await ModalModel.findByIdAndUpdate(localModal._id, {
      $set: {
        title: validated.title,
        subtitle: validated.subtitle,
        description: validated.description,
        'generationMetadata.sourceContentHash': manifestEntry.contentHash,
        'generationMetadata.lastSyncedAt': new Date(),
      },
    });

    this.logger.info('Updated local modal with production changes', {
      localModalId: localModal._id?.toString(),
      sourceModalId: manifestEntry.id,
      newTitle: validated.title,
    });
  }

  /**
   * Fetch manifest from S3 distribution.
   */
  private static async fetchManifest(): Promise<Manifest | null> {
    const distributionUrl = await getDistributionUrl();
    const url = `${distributionUrl}/manifest.json`;

    try {
      this.logger.info('Fetching manifest from production', { url });
      const response = await client.get(url);

      const validated = ManifestSchema.safeParse(response.data);
      if (!validated.success) {
        this.logger.warn('Invalid manifest schema from production', {
          errors: validated.error.issues,
        });
        return null;
      }

      this.logger.info('Successfully fetched manifest', {
        version: validated.data.version,
        modalCount: validated.data.modals.length,
      });

      return validated.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.logger.info('Manifest not found at distribution URL (404)', { url });
        return null;
      }
      throw error;
    }
  }
}

/**
 * Available modal entry with import status.
 */
export interface AvailableModalEntry extends ManifestModalEntry {
  status: 'available' | 'imported';
}

/**
 * Result of importing a modal by key.
 */
export interface ImportModalResult {
  success: boolean;
  key: string;
  modalId?: string;
  generatedDate?: string;
  title?: string;
  reason?: string;
}
