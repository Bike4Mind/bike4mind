import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  markFailed: vi.fn(),
  findAllByIds: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  delegatedItemRepository: { create: mocks.create, markFailed: mocks.markFailed },
  fabFileRepository: { findAllByIds: mocks.findAllByIds },
}));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  DelegationEvents: { Process: { publish: mocks.publish } },
}));

import { createDelegation } from './createDelegation';

const stored = { _id: { toString: () => 'g1' }, userId: 'u1' };

describe('createDelegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue(stored);
    mocks.publish.mockResolvedValue(undefined);
    mocks.findAllByIds.mockResolvedValue([
      { id: 'f1', userId: 'u1' },
      { id: 'f2', userId: 'u1' },
    ]);
  });

  it('stores the item as pending and hands it to the worker', async () => {
    const item = await createDelegation('u1', {
      intent: '  Summarize for the team ',
      url: 'https://example.com/r',
      file_ids: ['f1', 'f2', 'f1'],
    });

    expect(item).toBe(stored);
    expect(mocks.findAllByIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(mocks.create).toHaveBeenCalledWith({
      userId: 'u1',
      intent: 'Summarize for the team',
      url: 'https://example.com/r',
      text: null,
      fileIds: ['f1', 'f2'],
    });
    expect(mocks.publish).toHaveBeenCalledWith({ delegationId: 'g1', userId: 'u1' }, { requireAcceptance: true });
  });

  it('accepts text alone without looking up files', async () => {
    await createDelegation('u1', { intent: 'Handle this', text: 'Call the vendor back.' });
    expect(mocks.findAllByIds).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ url: null, text: 'Call the vendor back.' }));
  });

  it('422s when nothing was shared', async () => {
    await expect(createDelegation('u1', { intent: 'Handle this', file_ids: [] })).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('422s whitespace-only text with nothing else shared', async () => {
    await expect(createDelegation('u1', { intent: 'Handle this', text: ' \n\t ' })).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('stores whitespace-only text as absent when a link is shared', async () => {
    await createDelegation('u1', { intent: 'Read', url: 'https://example.com/r', text: '   ' });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/r', text: null }));
  });

  it('404s a file that is missing or belongs to someone else, and stores nothing', async () => {
    mocks.findAllByIds.mockResolvedValue([{ id: 'f1', userId: 'u2' }]);
    await expect(createDelegation('u1', { intent: 'Read', file_ids: ['f1'] })).rejects.toMatchObject({
      statusCode: 404,
    });
    mocks.findAllByIds.mockResolvedValue([]);
    await expect(createDelegation('u1', { intent: 'Read', file_ids: ['f9'] })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('fails the stored item and 502s when the hand-off cannot be published', async () => {
    mocks.publish.mockRejectedValue(new Error('bus down'));
    await expect(createDelegation('u1', { intent: 'Read', text: 'x' })).rejects.toMatchObject({ statusCode: 502 });
    expect(mocks.markFailed).toHaveBeenCalledWith('g1', 'dispatch_failed', expect.any(Date));
  });
});
