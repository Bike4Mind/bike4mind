import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain,
// matching the repo's handler-test convention.
const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  modal: null as any,
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
    findById: () => Promise.resolve(mockRefs.modal),
    findOneAndDelete: () => Promise.resolve(mockRefs.modal),
  },
}));

vi.mock('@server/services/whatsNewDistribution', () => ({
  WhatsNewDistributionService: {
    deleteModal: vi.fn(async () => {
      throw new Error('s3 down');
    }),
  },
}));

vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  emitModalGenerationMetrics: vi.fn(async () => undefined),
}));

import { emitModalGenerationMetrics } from '@bike4mind/server-utils/utils/cloudwatch';
import '@pages/api/modals/[id]/delete';

const MODAL_ID = '507f1f77bcf86cd799439011';

describe('DELETE /api/modals/[id] - S3 distribution sync failure', () => {
  // The response ends the Lambda invocation, so the failure metric emit must finish before it is sent.
  it('waits for the S3SyncFailure metric before responding when the S3 delete fails', async () => {
    mockRefs.modal = { _id: MODAL_ID, tags: ['whats-new'], generationMetadata: { generatedDate: '2026-09-20' } };
    let release!: () => void;
    vi.mocked(emitModalGenerationMetrics).mockReturnValueOnce(
      new Promise<void>(resolve => {
        release = resolve;
      })
    );
    const { req, res } = createMocks({ method: 'DELETE', query: { id: MODAL_ID } });
    (req as any).ability = { can: () => true };
    const pending = mockRefs.deleteHandler!(req, res);

    await vi.waitFor(() => expect(emitModalGenerationMetrics).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(res._isEndCalled()).toBe(false);

    release();
    await pending;
    expect(res._getStatusCode()).toBe(200);
  });
});
