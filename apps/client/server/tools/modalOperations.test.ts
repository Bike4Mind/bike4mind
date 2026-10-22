// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const model = vi.hoisted(() => ({
  create: vi.fn(),
  findById: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  findByIdAndDelete: vi.fn(),
}));

vi.mock('@bike4mind/database/social', () => ({ ModalModel: model }));
vi.mock('./modalImageHandler', () => ({ ModalImageHandler: { processModalImageUrl: vi.fn() } }));
vi.mock('@server/utils/cacheExternalImage', () => ({ cacheExternalImage: vi.fn() }));

import { collectModalChanges, createModal, deleteModal, updateModal } from './modalOperations';

const ID = '64b7f0c2a1b2c3d4e5f60718';

describe('collectModalChanges', () => {
  beforeEach(() => vi.clearAllMocks());

  it('collects the writes that succeeded inside the callback', async () => {
    model.create.mockResolvedValue({ _id: 'new-1', title: 'Welcome' });
    model.findById.mockResolvedValue({ _id: ID, tags: [] });
    model.findByIdAndUpdate.mockResolvedValue({ _id: ID, textMessage: 'Banner' });
    model.findByIdAndDelete.mockResolvedValue({ _id: 'gone-1', title: 'Old' });

    const { changes } = await collectModalChanges(async () => {
      await createModal({ type: 'modal', title: 'Welcome' });
      await updateModal(ID, { enabled: true });
      await deleteModal('gone-1');
    });

    expect(changes).toEqual([
      { kind: 'created', id: 'new-1', title: 'Welcome' },
      { kind: 'updated', id: ID, title: 'Banner' },
      { kind: 'deleted', id: 'gone-1', title: 'Old' },
    ]);
  });

  it('does not collect a delete that found nothing', async () => {
    model.findByIdAndDelete.mockResolvedValue(null);

    const { changes } = await collectModalChanges(() => deleteModal('missing'));

    expect(changes).toEqual([]);
  });

  it('is a no-op outside a collector', async () => {
    model.findByIdAndDelete.mockResolvedValue({ _id: 'x', title: 'X' });
    await expect(deleteModal('x')).resolves.toMatchObject({ success: true });
  });
});
