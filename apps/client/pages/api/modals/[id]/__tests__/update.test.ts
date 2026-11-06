import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createMocks } from 'node-mocks-http';

const audit = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: audit,
  definedKeys: (data: Record<string, unknown>) => Object.keys(data).filter(key => data[key] !== undefined),
}));

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain,
// matching the repo's handler-test convention.
// Read when the route module loads, which is before any test body runs
vi.hoisted(() => {
  process.env.S3_PRESIGN_ENDPOINT = 'http://localhost:9000';
  process.env.SERVER_DOMAIN = 'example.test';
});

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
  modal: null as any,
  findOneAndUpdate: vi.fn(),
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
    findOneAndUpdate: (...args: unknown[]) => mockRefs.findOneAndUpdate(...args),
  },
}));

vi.mock('@server/utils/cacheExternalImage', () => ({
  cacheExternalImage: vi.fn(async (url: string) => url),
  cacheExternalImages: vi.fn(async (images: unknown[]) => images),
}));

vi.mock('@bike4mind/services', () => ({
  extractVariantForViewer: (doc: any) => doc,
  viewerClassifier: {
    classify: vi.fn(async () => 'customer'),
  },
}));

import '@pages/api/modals/[id]/update';

const MODAL_ID = '507f1f77bcf86cd799439011';

function mocks(body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'PUT', query: { id: MODAL_ID }, body });
  (req as any).ability = { can: () => true };
  (req as any).user = { id: 'admin-1', isAdmin: true };
  return { req, res };
}

afterAll(() => {
  delete process.env.S3_PRESIGN_ENDPOINT;
  delete process.env.SERVER_DOMAIN;
});

describe('PUT /api/modals/[id] - video', () => {
  const video = {
    landscapeUrl: 'https://bucket.s3.us-east-2.amazonaws.com/modals/demo-16x9.mp4',
    landscapePosterUrl: 'https://bucket.s3.us-east-2.amazonaws.com/modals/demo-16x9.png',
    portraitUrl: 'https://d111.cloudfront.net/demo-9x16.mp4',
    portraitPosterUrl: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    audit.mockResolvedValue(null);
    mockRefs.findOneAndUpdate.mockImplementation(async () => mockRefs.modal);
    mockRefs.modal = { _id: { toString: () => MODAL_ID }, title: 'Demo', tags: [], toObject: () => mockRefs.modal };
  });

  it('persists the video urls', async () => {
    const { req, res } = mocks({ video });
    await mockRefs.putHandler!(req, res);

    const [, update] = mockRefs.findOneAndUpdate.mock.calls[0];
    expect(update.$set.video).toEqual(video);
    expect(audit.mock.calls[0][0]).toBe(req);
    expect(audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.modal.updated',
      target: { kind: 'settings', id: MODAL_ID, displayName: 'Demo' },
      details: { via: 'admin-modals', fields: ['video'] },
    });
    expect(mockRefs.findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(audit.mock.invocationCallOrder[0]);
  });

  it('audits explicit false and null field names without their values', async () => {
    const { req, res } = mocks({ enabled: false, video: null, subtitle: undefined });

    await mockRefs.putHandler!(req, res);

    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0][1].details).toEqual({ via: 'admin-modals', fields: ['video', 'enabled'] });
  });

  it('audits only the fields that changed when the body includes unchanged fields', async () => {
    mockRefs.modal = { ...mockRefs.modal, enabled: true };
    const { req, res } = mocks({ title: 'Demo', enabled: false });

    await mockRefs.putHandler!(req, res);

    expect(audit.mock.calls[0][1].details).toEqual({ via: 'admin-modals', fields: ['enabled'] });
  });

  it.each(['database failure', 'concurrent deletion', 'missing modal', 'permission denied'])(
    'records nothing after %s',
    async failure => {
      const { req, res } = mocks({ enabled: false });
      if (failure === 'database failure') mockRefs.findOneAndUpdate.mockRejectedValueOnce(new Error('write failed'));
      if (failure === 'concurrent deletion') mockRefs.findOneAndUpdate.mockResolvedValueOnce(null);
      if (failure === 'missing modal') mockRefs.modal = null;
      if (failure === 'permission denied') Object.assign(req, { ability: { can: () => false } });

      await expect(mockRefs.putHandler!(req, res)).rejects.toThrow();

      expect(audit).not.toHaveBeenCalled();
    }
  );

  it('returns 404 when the modal is deleted between the read and the update', async () => {
    const { req, res } = mocks({ enabled: false });
    mockRefs.findOneAndUpdate.mockResolvedValueOnce(null);

    await expect(mockRefs.putHandler!(req, res)).rejects.toMatchObject({ statusCode: 404, message: 'Modal not found' });
  });

  it('accepts clearing the video', async () => {
    const { req, res } = mocks({ video: null });
    await mockRefs.putHandler!(req, res);

    const [, update] = mockRefs.findOneAndUpdate.mock.calls[0];
    expect(update.$set.video).toBeNull();
  });

  it.each([
    ['the self-host object store', 'http://localhost:9000/fab-bucket/modals/demo.mp4'],
    ['the files host', 'https://files.dev.example.test/modals/demo.mp4'],
  ])('accepts a url on %s', async (_case, url) => {
    const { req, res } = mocks({ video: { landscapeUrl: url } });
    await mockRefs.putHandler!(req, res);

    const [, update] = mockRefs.findOneAndUpdate.mock.calls[0];
    expect(update.$set.video).toEqual({ landscapeUrl: url });
  });

  it.each([
    ['another port on the object store host', { landscapeUrl: 'http://localhost:9001/fab-bucket/a.mp4' }],
    ['https on the http-only object store', { landscapeUrl: 'https://localhost:9000/fab-bucket/a.mp4' }],
    ['a non-http url', { ...video, landscapeUrl: 'javascript:alert(1)' }],
    ['a host the CSP does not allow', { ...video, landscapeUrl: 'https://cdn.example.com/a.mp4' }],
    ['a poster without its video', { portraitPosterUrl: video.landscapePosterUrl }],
  ])('rejects %s', async (_case, bad) => {
    const { req, res } = mocks({ video: bad });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow();
    expect(mockRefs.findOneAndUpdate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('PUT /api/modals/[id] - response audience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audit.mockResolvedValue(null);
    mockRefs.findOneAndUpdate.mockImplementation(async () => mockRefs.modal);
    mockRefs.modal = { _id: { toString: () => MODAL_ID }, title: 'Demo', tags: [], toObject: () => mockRefs.modal };
  });

  it.each([
    ['a full admin', { isAdmin: true }, true],
    ['a settings:manage delegate', { isAdmin: false, adminPermissions: ['settings:manage'] }, true],
    ['a delegate holding only another permission', { isAdmin: false, adminPermissions: ['support:read'] }, false],
  ])('classifies %s', async (_case, user, expectedAdmin) => {
    const { viewerClassifier } = await import('@bike4mind/services');
    const { req, res } = mocks({ enabled: false });
    (req as any).user = { id: 'user-1', ...user };

    await mockRefs.putHandler!(req, res);

    expect(viewerClassifier.classify).toHaveBeenCalledWith({ isAdmin: expectedAdmin });
  });
});
