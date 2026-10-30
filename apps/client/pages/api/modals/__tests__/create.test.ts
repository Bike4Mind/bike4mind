import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createMocks } from 'node-mocks-http';

const audit = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: audit,
  definedKeys: (data: Record<string, unknown>) => Object.keys(data).filter(key => data[key] !== undefined),
}));

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain,
// matching the repo's handler-test convention.
vi.hoisted(() => {
  process.env.S3_PRESIGN_ENDPOINT = 'http://localhost:9000';
  process.env.SERVER_DOMAIN = 'example.test';
});

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  created: undefined as any,
  saveCalls: 0,
  save: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database/social', () => ({
  ModalModel: class {
    _id = '507f1f77bcf86cd799439011';
    title: string | null = null;
    textMessage: string | null = null;
    constructor(data: unknown) {
      mockRefs.created = data;
      Object.assign(this, data);
    }
    save() {
      mockRefs.saveCalls += 1;
      return mockRefs.save();
    }
  },
}));

vi.mock('@server/utils/cacheExternalImage', () => ({
  cacheExternalImage: vi.fn(async (url: string) => url),
  cacheExternalImages: vi.fn(async (images: unknown[]) => images),
}));

import '@pages/api/modals/create';

const S3 = 'https://bucket.s3.us-east-2.amazonaws.com/modals';
const VIDEO = {
  landscapeUrl: `${S3}/wide.mp4`,
  landscapePosterUrl: `${S3}/wide.png`,
  portraitUrl: 'https://d111.cloudfront.net/tall.mp4',
  portraitPosterUrl: null,
};

const body = (video?: unknown) => ({
  title: 'Demo',
  subtitle: null,
  textMessage: null,
  imageUrl: null,
  ...(video !== undefined && { video }),
  description: null,
  tags: null,
  startDate: null,
  endDate: null,
  numberOfAgrees: null,
  numberOfViews: null,
});

function mocks(requestBody: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body: requestBody });
  (req as any).ability = { can: () => true };
  (req as any).user = { id: 'admin-1', isAdmin: true };
  return { req, res };
}

describe('POST /api/modals - video', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.save.mockResolvedValue(undefined);
    audit.mockResolvedValue(null);
    mockRefs.created = undefined;
    mockRefs.saveCalls = 0;
  });

  it('creates a modal with the video it was sent', async () => {
    const { req, res } = mocks(body(VIDEO));
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(mockRefs.created.video).toEqual(VIDEO);
    expect(mockRefs.saveCalls).toBe(1);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0][0]).toBe(req);
    expect(audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.modal.created',
      target: { kind: 'settings', id: '507f1f77bcf86cd799439011', displayName: 'Demo' },
      details: { via: 'admin-modals' },
    });
    expect(mockRefs.save.mock.invocationCallOrder[0]).toBeLessThan(audit.mock.invocationCallOrder[0]);
  });

  it('records nothing when saving fails', async () => {
    mockRefs.save.mockRejectedValueOnce(new Error('save failed'));
    const { req, res } = mocks(body());

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow('save failed');

    expect(audit).not.toHaveBeenCalled();
  });

  it('records nothing when permission is denied', async () => {
    const { req, res } = mocks(body());
    Object.assign(req, { ability: { can: () => false } });

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow('Permission denied');

    expect(mockRefs.save).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects a video on a host the deployment does not allow, saving nothing', async () => {
    const { req, res } = mocks(body({ ...VIDEO, landscapeUrl: 'https://cdn.example.com/a.mp4' }));
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();

    expect(mockRefs.created).toBeUndefined();
    expect(mockRefs.saveCalls).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  delete process.env.S3_PRESIGN_ENDPOINT;
  delete process.env.SERVER_DOMAIN;
});
