import { Resource } from 'sst';
import { sendToClient } from '@server/websocket/utils';
import { importHistoryJobRepository, IImportHistoryJob } from '@bike4mind/database/content';

interface ProgressUpdate {
  progress: number;
  currentStep: string;
  processedItems?: number;
  totalItems?: number;
}

/**
 * Updates import progress in database and sends WebSocket notification to client
 */
export async function updateImportProgress(
  importHistoryJobId: string,
  userId: string,
  update: ProgressUpdate
): Promise<void> {
  await importHistoryJobRepository.updateProgress(importHistoryJobId, update.progress, update.currentStep);

  if (update.totalItems !== undefined || update.processedItems !== undefined) {
    const updateFields: Partial<IImportHistoryJob> = { updatedAt: new Date() };
    if (update.totalItems !== undefined) updateFields.totalItems = update.totalItems;
    if (update.processedItems !== undefined) updateFields.processedItems = update.processedItems;

    // @ts-ignore - BaseRepository update expects full object but we're doing partial update
    await importHistoryJobRepository.model.updateOne({ _id: importHistoryJobId }, { $set: updateFields });
  }

  await sendToClient(userId, Resource.websocket.managementEndpoint, {
    action: 'import_history_job_progress',
    importHistoryJobId,
    status: 'processing',
    progress: update.progress,
    currentStep: update.currentStep,
    ...(update.processedItems !== undefined && { processedItems: update.processedItems }),
    ...(update.totalItems !== undefined && { totalItems: update.totalItems }),
  });
}

/**
 * Marks import as completed in database and sends WebSocket notification
 */
export async function markImportComplete(
  importHistoryJobId: string,
  userId: string,
  stats: { processedItems: number; skippedItems: number }
): Promise<void> {
  await importHistoryJobRepository.markComplete(importHistoryJobId, stats);

  await sendToClient(userId, Resource.websocket.managementEndpoint, {
    action: 'import_history_job_progress',
    importHistoryJobId,
    status: 'completed',
    progress: 100,
    currentStep: 'Import completed successfully',
    processedItems: stats.processedItems,
  });
}

/**
 * Marks import as failed in database and sends WebSocket notification
 */
export async function markImportFailed(
  importHistoryJobId: string,
  userId: string,
  error: { message: string; stack?: string }
): Promise<void> {
  await importHistoryJobRepository.markFailed(importHistoryJobId, error);

  await sendToClient(userId, Resource.websocket.managementEndpoint, {
    action: 'import_history_job_progress',
    importHistoryJobId,
    status: 'failed',
    progress: 0,
    currentStep: 'Import failed',
    errorMessage: error.message,
  });
}
