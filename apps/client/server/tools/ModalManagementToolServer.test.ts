import { describe, expect, it, vi, beforeEach } from 'vitest';

const { findOne, find, findById } = vi.hoisted(() => ({
  findOne: vi.fn(),
  find: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@bike4mind/database/social', () => ({
  ModalModel: { findOne, find, findById },
}));
vi.mock('@client/pages/api/admin/modal-tool', () => ({ parseNaturalLanguageQueryDirect: vi.fn() }));
vi.mock('@client/app/services/adminTools/modalToolHelpers', () => ({
  showHelp: vi.fn(),
  buildModalFromParams: vi.fn(),
  generateModalFromNaturalLanguage: vi.fn(),
  generateModalContentFromContext: vi.fn(),
  NO_CHAT_CONTEXT_MESSAGE: '',
  suggestTags: vi.fn(),
  findModalByPartialId: vi.fn(),
}));
vi.mock('./modalOperations', () => ({
  createModal: vi.fn(),
  updateModal: vi.fn(),
  deleteModal: vi.fn(),
  listModals: vi.fn(),
}));

import { ModalManagementToolServer } from './ModalManagementToolServer';

// triggerModal is private; reach it directly - it is the regex-compilation sink.
const triggerModal = (query: string) =>
  (
    new ModalManagementToolServer() as unknown as {
      triggerModal(context: unknown, params: unknown): Promise<unknown>;
    }
  ).triggerModal({}, { query });

describe('ModalManagementToolServer triggerModal title-lookup regex escaping', () => {
  beforeEach(() => {
    findOne.mockReset().mockReturnValue({ lean: () => null });
    find.mockReset().mockReturnValue({ sort: () => ({ lean: () => [] }) });
    findById.mockReset().mockReturnValue({ lean: () => null });
  });

  it('escapes regex metacharacters in the $regex operand instead of passing them raw', async () => {
    // Not hex, so the id branches fall through to the title lookup.
    await triggerModal('(a+)+$');

    expect(findOne).toHaveBeenCalledTimes(1);
    const titleRe = findOne.mock.calls[0][0].title as RegExp;

    // The metacharacters are now literal, not operators.
    expect(titleRe.source).toBe('\\(a\\+\\)\\+\\$');
    expect(titleRe.test('(a+)+$')).toBe(true);
    expect(titleRe.test('aaaa')).toBe(false);
  });

  it('leaves an ordinary identifier matchable (contains semantics preserved)', async () => {
    await triggerModal('Launch');

    const titleRe = findOne.mock.calls[0][0].title as RegExp;
    expect(titleRe.test('Summer Launch Event')).toBe(true);
    expect(titleRe.flags).toContain('i');
  });
});
