import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain,
// matching the repo's handler-test convention.
const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
  modal: null as any,
  updateExistingModalCall: undefined as any,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database/social', () => ({
  ModalModel: {
    findById: () => Promise.resolve(mockRefs.modal),
    findOneAndUpdate: () => Promise.resolve(mockRefs.modal),
  },
}));

vi.mock('@server/utils/cacheExternalImage', () => ({
  cacheExternalImage: vi.fn(async (url: string) => url),
  cacheExternalImages: vi.fn(async (images: unknown[]) => images),
}));

vi.mock('@server/services/whatsNewDistribution', () => ({
  WhatsNewDistributionService: {
    updateExistingModal: vi.fn(async (...args: unknown[]) => {
      mockRefs.updateExistingModalCall = args;
    }),
  },
}));

vi.mock('@server/utils/cloudwatch', () => ({
  emitModalGenerationMetrics: vi.fn(async () => undefined),
}));

vi.mock('@bike4mind/services', () => ({
  extractVariantForViewer: (doc: any) => doc,
  viewerClassifier: {
    classify: vi.fn(async () => 'customer'),
  },
  MODAL_SAFE_DEFAULT_KEY: 'customer',
}));

import '@pages/api/modals/[id]/update';

const MODAL_ID = '507f1f77bcf86cd799439011';

function mocks(body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'PUT', query: { id: MODAL_ID }, body });
  (req as any).ability = { can: () => true };
  (req as any).user = { id: 'admin-1', isAdmin: true };
  return { req, res };
}

describe('PUT /api/modals/[id] - S3 distribution repository metadata', () => {
  beforeEach(() => {
    mockRefs.updateExistingModalCall = undefined;
    mockRefs.modal = {
      _id: { toString: () => MODAL_ID },
      tags: ['whats-new'],
      generationMetadata: {
        generatedDate: '2026-09-20',
        releaseTag: 'v1.2.3',
        modelUsed: 'gpt-5',
        correlationId: 'corr-1',
      },
      variants: { customer: {} },
      title: 'Updated title',
      subtitle: '',
      description: '',
      createdAt: new Date('2026-09-20T00:00:00Z'),
      toObject: () => mockRefs.modal,
    };
  });

  it('publishes the canonical repository URL, not the retired one', async () => {
    const { req, res } = mocks({ title: 'Updated title' });
    await mockRefs.putHandler!(req, res);

    expect(mockRefs.updateExistingModalCall).toBeDefined();
    const [, , content] = mockRefs.updateExistingModalCall;
    const payload = JSON.parse(content);
    expect(payload.metadata.repositoryUrl).toBe('https://github.com/Bike4Mind/bike4mind');
  });
});
