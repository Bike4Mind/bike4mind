import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain,
// matching the repo's handler-test convention.
const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  modal: null as any,
  findOneAndDelete: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database/social', () => ({
  ModalModel: {
    findOneAndDelete: (...args: unknown[]) => {
      mockRefs.findOneAndDelete(...args);
      return Promise.resolve(mockRefs.modal);
    },
  },
}));

import '@pages/api/modals/[id]/delete';

const MODAL_ID = '507f1f77bcf86cd799439011';

function mocks(id = MODAL_ID) {
  const { req, res } = createMocks({ method: 'DELETE', query: { id } });
  (req as any).ability = { can: () => true };
  return { req, res };
}

describe('DELETE /api/modals/[id]', () => {
  it('deletes the modal and returns it', async () => {
    mockRefs.modal = { _id: MODAL_ID, tags: ['whats-new'] };
    const { req, res } = mocks();

    await mockRefs.deleteHandler!(req, res);

    expect(mockRefs.findOneAndDelete).toHaveBeenCalledWith({ _id: MODAL_ID });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(mockRefs.modal);
  });

  it('404s a malformed id instead of letting the cast throw', async () => {
    mockRefs.findOneAndDelete.mockClear();
    const { req, res } = mocks('not-an-object-id');

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('Modal not found');
    expect(mockRefs.findOneAndDelete).not.toHaveBeenCalled();
  });
});
