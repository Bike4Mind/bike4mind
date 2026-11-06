// @vitest-environment node
/**
 * The admin modal tool parses a natural-language request with a platform-key completion, billed to the
 * admin who invoked the tool: the parse step must receive a meter built for that user.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insufficientCreditsError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  parse: vi.fn(),
  createCompletionMeter: vi.fn(),
  meter: vi.fn(),
}));

vi.mock('@bike4mind/database/social', () => ({ ModalModel: {} }));
vi.mock('@client/pages/api/admin/modal-tool', () => ({ parseNaturalLanguageQueryDirect: h.parse }));
vi.mock('@server/billing/meterPlatformCompletion', () => ({ createCompletionMeter: h.createCompletionMeter }));
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

const user = { id: 'admin-1' };
const run = () =>
  (
    new ModalManagementToolServer() as unknown as {
      processWithLLM(context: unknown, params: unknown): Promise<{ success: boolean; error?: string }>;
    }
  ).processWithLLM({ user }, { query: 'add a banner' });

describe('ModalManagementToolServer parse metering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createCompletionMeter.mockReturnValue(h.meter);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('bills the calling admin through a system-model meter handed to the parse step', async () => {
    h.parse.mockRejectedValue(new Error('stop after parse'));

    await run();

    expect(h.createCompletionMeter).toHaveBeenCalledWith(user, expect.anything(), expect.any(String), {
      systemModel: true,
    });
    expect(h.parse.mock.calls[0][2]).toBe(h.meter);
  });

  it('reports a credit refusal as the tool error', async () => {
    h.parse.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(run()).resolves.toEqual({ success: false, error: 'You do not have enough credits.' });
  });
});
