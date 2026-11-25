import { describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { getQuestErrorCode } from '@bike4mind/common';
import type { IObligation } from '@bike4mind/database';
import { handOffDocument, type HandOffDeps } from './handOffDocument';

const FILE_ID = new mongoose.Types.ObjectId().toString();
const REPLY = JSON.stringify({
  document_kind: 'invoice',
  payee: 'Acme Water',
  amount: 184.37,
  currency: 'USD',
  due_date: '2026-12-04',
  destination_index: 1,
  summary: 'Water bill.',
});

// Mirrors the production contract: charge under the returned id only after `store` resolves.
function completeWith(reply: string, recordUsage: (sessionId: string) => Promise<void>): HandOffDeps['complete'] {
  return async (_userId, _prompt, store) => {
    const { sessionId, value } = await store(reply, 'ops-model');
    await recordUsage(sessionId);
    return value;
  };
}

function makeDeps(overrides: Partial<HandOffDeps> = {}) {
  const recordUsage = vi.fn(async (_sessionId: string) => {});
  const deps: HandOffDeps = {
    obligations: {
      findByFileForUser: vi.fn(async () => null),
      create: vi.fn(async input => ({
        obligation: { ...input, status: 'pending' } as unknown as IObligation,
        created: true,
      })),
    },
    findFile: vi.fn(async () => ({ moderationStatus: 'clean' as const })),
    fileText: vi.fn(async () => 'indexed text'),
    listLakes: vi.fn(async () => [{ id: 'lake-1', name: 'Bills' }]),
    canFund: vi.fn(async () => true),
    complete: vi.fn(completeWith(REPLY, recordUsage)),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as HandOffDeps['logger'],
    ...overrides,
  };
  return { deps, recordUsage };
}

describe('handOffDocument', () => {
  it('extracts, stores a pending row and records usage against its id', async () => {
    const { deps, recordUsage } = makeDeps();
    const result = await handOffDocument('user-me', { file_id: FILE_ID, text: 'ACME WATER total 184.37' }, deps);

    expect(result.created).toBe(true);
    const input = vi.mocked(deps.obligations.create).mock.calls[0][0];
    expect(input).toMatchObject({
      userId: 'user-me',
      fileId: FILE_ID,
      amountValue: 184.37,
      currency: 'USD',
      payee: 'Acme Water',
      dueDate: new Date('2026-12-04T00:00:00.000Z'),
      destinationLakeId: 'lake-1',
      destinationName: 'Bills',
      model: 'ops-model',
    });
    expect(recordUsage).toHaveBeenCalledWith(input._id?.toString());
    expect(deps.fileText).not.toHaveBeenCalled();
    expect(vi.mocked(deps.complete).mock.calls[0][1]).toContain('ACME WATER total 184.37');
  });

  it('returns the existing row on a retry without a model call', async () => {
    const existing = { fileId: FILE_ID } as unknown as IObligation;
    const { deps } = makeDeps({
      obligations: { findByFileForUser: vi.fn(async () => existing), create: vi.fn() },
    });
    await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).resolves.toEqual({
      obligation: existing,
      created: false,
    });
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.canFund).not.toHaveBeenCalled();
  });

  it('404s a foreign or malformed file id', async () => {
    const { deps } = makeDeps({ findFile: vi.fn(async () => null) });
    await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).rejects.toMatchObject({ statusCode: 404 });
    const malformed = makeDeps();
    await expect(handOffDocument('user-me', { file_id: 'nope' }, malformed.deps)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(malformed.deps.findFile).not.toHaveBeenCalled();
  });

  it('409s a file still being scanned and 422s a blocked one', async () => {
    for (const moderationStatus of ['pending', 'scanning'] as const) {
      const { deps } = makeDeps({ findFile: vi.fn(async () => ({ moderationStatus })) });
      await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).rejects.toMatchObject({ statusCode: 409 });
    }
    const { deps } = makeDeps({ findFile: vi.fn(async () => ({ moderationStatus: 'blocked' as const })) });
    await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('falls back to indexed text for blank device text, and 422s when both are empty', async () => {
    const fallback = makeDeps();
    await handOffDocument('user-me', { file_id: FILE_ID, text: '   ' }, fallback.deps);
    expect(fallback.deps.fileText).toHaveBeenCalledWith(FILE_ID);

    const { deps } = makeDeps({ fileText: vi.fn(async () => ' \n ') });
    await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).rejects.toMatchObject({ statusCode: 422 });
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('422s an unfunded payer as insufficient_credits before the model call', async () => {
    const { deps } = makeDeps({ canFund: vi.fn(async () => false) });
    const error = await handOffDocument('user-me', { file_id: FILE_ID }, deps).catch((err: unknown) => err);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(getQuestErrorCode(error)).toBe('insufficient_credits');
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('502s a non-JSON reply, stores nothing and still charges the reading', async () => {
    const recordUsage = vi.fn(async (_sessionId: string) => {});
    const { deps } = makeDeps({
      complete: vi.fn(completeWith('Sorry, I cannot help.', recordUsage)),
    });
    await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).rejects.toMatchObject({ statusCode: 502 });
    expect(deps.obligations.create).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed credit check instead of reporting the payer unfunded', async () => {
    const { deps } = makeDeps({ canFund: vi.fn(async () => Promise.reject(new Error('billing down'))) });
    await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).rejects.toThrow('billing down');
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('stores nothing when the model call itself fails', async () => {
    const { deps } = makeDeps({ complete: vi.fn(async () => Promise.reject(new Error('provider down'))) });
    await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).rejects.toThrow('provider down');
    expect(deps.obligations.create).not.toHaveBeenCalled();
  });

  it('returns the winning row and still charges the reading when a concurrent hand-off stored first', async () => {
    const winner = { fileId: FILE_ID, status: 'pending' } as unknown as IObligation;
    const { deps, recordUsage } = makeDeps({
      obligations: {
        findByFileForUser: vi.fn(async () => null),
        create: vi.fn(async () => ({ obligation: winner, created: false })),
      },
    });
    await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).resolves.toEqual({
      obligation: winner,
      created: false,
    });
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('does not charge when storing the row fails', async () => {
    const { deps, recordUsage } = makeDeps({
      obligations: {
        findByFileForUser: vi.fn(async () => null),
        create: vi.fn(async () => Promise.reject(new Error('db down'))),
      },
    });
    await expect(handOffDocument('user-me', { file_id: FILE_ID }, deps)).rejects.toThrow('db down');
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('looks a mixed-case file id up in canonical form', async () => {
    const { deps } = makeDeps();
    await handOffDocument('user-me', { file_id: FILE_ID.toUpperCase() }, deps);
    expect(deps.obligations.findByFileForUser).toHaveBeenCalledWith(FILE_ID, 'user-me');
    expect(vi.mocked(deps.obligations.create).mock.calls[0][0].fileId).toBe(FILE_ID);
  });
});
