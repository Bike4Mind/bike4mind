import { describe, expect, it, vi, beforeEach } from 'vitest';

const { findOne, find } = vi.hoisted(() => ({ findOne: vi.fn(), find: vi.fn() }));

vi.mock('@bike4mind/database/social', () => ({
  ModalModel: { findOne, find, findById: vi.fn() },
}));
vi.mock('./modalImageHandler', () => ({ ModalImageHandler: class {} }));
vi.mock('@server/utils/cacheExternalImage', () => ({ cacheExternalImage: vi.fn() }));

import { updateModal } from './modalOperations';

describe('updateModal search-term regex escaping', () => {
  beforeEach(() => {
    findOne.mockReset().mockResolvedValue(null);
    find.mockReset().mockReturnValue({ lean: () => [] });
  });

  it('escapes regex metacharacters in the $regex operand instead of passing them raw', async () => {
    await updateModal(undefined, { title: '(a+)+$' });

    expect(findOne).toHaveBeenCalledTimes(1);
    const query = findOne.mock.calls[0][0];
    const titleRe = query.$or[0].title as RegExp;
    const textRe = query.$or[1].textMessage as RegExp;

    // The metacharacters are now literal, not operators.
    expect(titleRe.source).toBe('\\(a\\+\\)\\+\\$');
    expect(textRe.source).toBe('\\(a\\+\\)\\+\\$');

    // And the compiled regex no longer catastrophically backtracks.
    const t0 = performance.now();
    expect(titleRe.test('a'.repeat(50) + '!')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('leaves an ordinary search term matchable (contains semantics preserved)', async () => {
    await updateModal(undefined, { title: 'Launch' });

    const titleRe = findOne.mock.calls[0][0].$or[0].title as RegExp;
    expect(titleRe.test('Summer Launch Event')).toBe(true);
    expect(titleRe.flags).toContain('i');
  });
});
