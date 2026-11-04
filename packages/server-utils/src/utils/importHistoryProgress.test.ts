import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  updateProgress: vi.fn(),
  updateOne: vi.fn(),
  markComplete: vi.fn(),
  markFailed: vi.fn(),
  sendToClient: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://ws.test' } } }));
vi.mock('../websocket/utils', () => ({ sendToClient: h.sendToClient }));
vi.mock('@bike4mind/database/content', () => ({
  importHistoryJobRepository: {
    updateProgress: h.updateProgress,
    markComplete: h.markComplete,
    markFailed: h.markFailed,
    model: { updateOne: h.updateOne },
  },
}));

import { updateImportProgress, markImportComplete, markImportFailed } from './importHistoryProgress';

describe('importHistoryProgress', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updateImportProgress writes progress, the item counts, and notifies the owner', async () => {
    await updateImportProgress('job-1', 'user-1', {
      progress: 40,
      currentStep: 'Importing',
      processedItems: 4,
      totalItems: 10,
    });

    expect(h.updateProgress).toHaveBeenCalledWith('job-1', 40, 'Importing');
    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: 'job-1' },
      { $set: { updatedAt: expect.any(Date), processedItems: 4, totalItems: 10 } }
    );
    expect(h.sendToClient).toHaveBeenCalledWith('user-1', 'https://ws.test', {
      action: 'import_history_job_progress',
      importHistoryJobId: 'job-1',
      status: 'processing',
      progress: 40,
      currentStep: 'Importing',
      processedItems: 4,
      totalItems: 10,
    });
  });

  it('updateImportProgress skips the count write when no counts are given', async () => {
    await updateImportProgress('job-1', 'user-1', { progress: 10, currentStep: 'Unzipping' });

    expect(h.updateOne).not.toHaveBeenCalled();
    expect(h.sendToClient.mock.calls[0][2]).toEqual({
      action: 'import_history_job_progress',
      importHistoryJobId: 'job-1',
      status: 'processing',
      progress: 10,
      currentStep: 'Unzipping',
    });
  });

  it('markImportComplete records the stats and reports 100% completed', async () => {
    const stats = { processedItems: 9, skippedItems: 1, totalItems: 10 };
    await markImportComplete('job-1', 'user-1', stats);

    expect(h.markComplete).toHaveBeenCalledWith('job-1', stats);
    expect(h.sendToClient).toHaveBeenCalledWith('user-1', 'https://ws.test', {
      action: 'import_history_job_progress',
      importHistoryJobId: 'job-1',
      status: 'completed',
      progress: 100,
      currentStep: 'Import completed successfully',
      processedItems: 9,
      totalItems: 10,
    });
  });

  it('markImportFailed records the error and reports failed with its message', async () => {
    const error = { message: 'bad zip', stack: 'at x' };
    await markImportFailed('job-1', 'user-1', error);

    expect(h.markFailed).toHaveBeenCalledWith('job-1', error);
    expect(h.sendToClient).toHaveBeenCalledWith('user-1', 'https://ws.test', {
      action: 'import_history_job_progress',
      importHistoryJobId: 'job-1',
      status: 'failed',
      progress: 0,
      currentStep: 'Import failed',
      errorMessage: 'bad zip',
    });
  });
});
