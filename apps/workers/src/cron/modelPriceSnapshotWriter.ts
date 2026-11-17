import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '@bike4mind/fab-pipeline';
import { modelPriceRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { MODEL_PRICE_SNAPSHOT_BUCKET_ENV, MODEL_PRICE_SNAPSHOT_KEY, type IModelPriceSnapshot } from '@bike4mind/common';

/**
 * Publishes the per-token ModelPrice rows in force for the usage poller, which has no database.
 * Never throws: a failed write must not fail the discovery run that triggered it.
 */
export async function publishModelPriceSnapshot(logger: Logger, now = new Date()): Promise<void> {
  const bucket = process.env[MODEL_PRICE_SNAPSHOT_BUCKET_ENV];
  if (!bucket) return;

  try {
    const rows = await modelPriceRepository.rowsInForce(now);
    const snapshot: IModelPriceSnapshot = {
      version: 1,
      generatedAt: now.toISOString(),
      rows: rows.filter(row => row.unit === 'per_token').map(row => ({ modelId: row.modelId, pricing: row.pricing })),
    };
    await createS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: MODEL_PRICE_SNAPSHOT_KEY,
        Body: JSON.stringify(snapshot),
        ContentType: 'application/json',
      })
    );
    logger.info('[model-discovery] model price snapshot written', { rows: snapshot.rows.length });
  } catch (error) {
    logger.error('[model-discovery] model price snapshot write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
