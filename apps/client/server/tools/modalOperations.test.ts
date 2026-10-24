// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const model = vi.hoisted(() => ({
  findOne: vi.fn(),
  find: vi.fn(),
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

describe('updateModal search-term regex escaping', () => {
  beforeEach(() => {
    model.findOne.mockReset().mockResolvedValue(null);
    model.find.mockReset().mockReturnValue({ lean: () => [] });
  });

  it('escapes regex metacharacters in the $regex operand instead of passing them raw', async () => {
    await updateModal(undefined, { title: '(a+)+$' });

    expect(model.findOne).toHaveBeenCalledTimes(1);
    const query = model.findOne.mock.calls[0][0];
    const titleRe = query.$or[0].title as RegExp;
    const textRe = query.$or[1].textMessage as RegExp;

    // The metacharacters are now literal, not operators.
    expect(titleRe.source).toBe('\\(a\\+\\)\\+\\$');
    expect(textRe.source).toBe('\\(a\\+\\)\\+\\$');

    // The escaped form is a literal, so it matches the raw text and nothing else. (No timing
    // assertion: the `.source` check above already fails if escaping is reverted, and a wall-clock
    // bound would only add CI flake.)
    expect(titleRe.test('(a+)+$')).toBe(true);
    expect(titleRe.test('aaaa')).toBe(false);
  });

  it('coerces a non-string search term instead of throwing inside escapeRegex', async () => {
    // `params` is untyped model output and can carry a number or boolean here. `new RegExp(123)`
    // used to coerce silently; escapeRegex would throw on `.replace`.
    await updateModal(undefined, { title: 123 });

    expect(model.findOne).toHaveBeenCalledTimes(1);
    expect((model.findOne.mock.calls[0][0].$or[0].title as RegExp).source).toBe('123');
  });

  it('leaves an ordinary search term matchable (contains semantics preserved)', async () => {
    await updateModal(undefined, { title: 'Launch' });

    const titleRe = model.findOne.mock.calls[0][0].$or[0].title as RegExp;
    expect(titleRe.test('Summer Launch Event')).toBe(true);
    expect(titleRe.flags).toContain('i');
  });
});
