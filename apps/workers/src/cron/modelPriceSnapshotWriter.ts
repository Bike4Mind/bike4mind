import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '@bike4mind/fab-pipeline';
import { modelPriceRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { modelPriceSnapshotDeadline, withModelPriceSnapshotBudget } from './modelPriceSnapshotBudget';
import { MODEL_PRICE_SNAPSHOT_BUCKET_ENV, MODEL_PRICE_SNAPSHOT_KEY, type IModelPriceSnapshot } from '@bike4mind/common';

/**
 * Publishes the per-token ModelPrice rows in force for the usage poller, which has no database.
 * Never throws: a failed write must not fail the discovery run that triggered it.
 */
export async function publishModelPriceSnapshot(
  logger: Logger,
  now = new Date(),
  options: { deadlineMs?: number } = {}
): Promise<void> {
  const bucket = process.env[MODEL_PRICE_SNAPSHOT_BUCKET_ENV];
  if (!bucket) return;

  try {
    await withModelPriceSnapshotBudget(
      Math.min(options.deadlineMs ?? Infinity, modelPriceSnapshotDeadline()),
      async (signal, assertActive) => {
        const rows = await modelPriceRepository.rowsInForce(now);
        // A late database read must not start an upload after this stage already timed out.
        assertActive();
        const snapshot: IModelPriceSnapshot = {
          version: 1,
          generatedAt: now.toISOString(),
          rows: rows
            .filter(row => row.unit === 'per_token')
            .map(row => ({ modelId: row.modelId, pricing: row.pricing })),
        };
        const body = JSON.stringify(snapshot);
        const client = createS3Client();
        assertActive();
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: MODEL_PRICE_SNAPSHOT_KEY,
            Body: body,
            ContentType: 'application/json',
          }),
          { abortSignal: signal }
        );
        assertActive();
        logger.info('[model-discovery] model price snapshot written', { rows: snapshot.rows.length });
      }
    );
  } catch (error) {
    logger.error('[model-discovery] model price snapshot write failed', {
      error: error instanceof Error ? error.message.slice(0, 200) : 'Unknown snapshot publication failure',
    });
  }
}
