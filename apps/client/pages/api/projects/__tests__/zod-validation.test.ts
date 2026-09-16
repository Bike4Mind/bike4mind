import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';
import { BadRequestError, InternalServerError, UnprocessableEntityError } from '@bike4mind/utils';

// ZodError must escape the try block now that parse is above it.
// This file pins that: a bad POST /api/projects body throws ZodError
// (previously it was swallowed into InternalServerError).

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const createProject = vi.hoisted(() => vi.fn(async () => ({ id: 'p1', name: 'n', description: 'd' })));
vi.mock('@bike4mind/services', () => ({ projectService: { createProject } }));
vi.mock('@bike4mind/database', () => ({ projectRepository: {}, fabFileRepository: {}, sessionRepository: {} }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn(async () => {}) }));

import '@pages/api/projects/index';

function makeReq(body: unknown) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = { id: 'u1' };
  (req as any).ability = null;
  (req as any).body = body;
  return { req, res };
}

describe('POST /api/projects -- Zod validation', () => {
  beforeEach(() => createProject.mockClear());

  it('accepts the real client payload (name + description)', async () => {
    const { req, res } = makeReq({ name: 'My Project', description: 'A project' });
    await mockRefs.postHandler!(req, res);
    expect(createProject).toHaveBeenCalledOnce();
  });

  it('accepts optional sessionIds and fileIds alongside required fields', async () => {
    const { req, res } = makeReq({
      name: 'Project B',
      description: 'desc',
      sessionIds: ['s1'],
      fileIds: ['f1'],
    });
    await mockRefs.postHandler!(req, res);
    expect(createProject).toHaveBeenCalledOnce();
  });

  it('rejects a missing name with ZodError -- no longer swallowed as 500', async () => {
    const { req, res } = makeReq({ description: 'A project' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ZodError);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('rejects a missing description with ZodError', async () => {
    const { req, res } = makeReq({ name: 'My Project' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ZodError);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('strips unknown keys before they reach the service', async () => {
    const { req, res } = makeReq({ name: 'n', description: 'd', _injected: { $gt: '' } });
    await mockRefs.postHandler!(req, res);
    const calledWith = createProject.mock.calls[0][1];
    expect(calledWith).not.toHaveProperty('_injected');
  });
});

describe('POST /api/projects -- service error passthrough', () => {
  beforeEach(() => createProject.mockReset());

  // createProject resolves supplied fileIds/sessionIds through the caller's access predicate and
  // raises BadRequestError when one does not resolve, which the client hits whenever a pick is
  // revoked between select and submit. The catch used to rewrap every non-11000 error as
  // InternalServerError, so that 400 reached the client as a 500.
  it('lets a typed service error keep its own status', async () => {
    createProject.mockRejectedValueOnce(new BadRequestError('Some files are not accessible') as never);
    const { req, res } = makeReq({ name: 'n', description: 'd', fileIds: ['f1'] });

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(BadRequestError);
  });

  it('still maps a duplicate-key write to 422', async () => {
    createProject.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }) as never);
    const { req, res } = makeReq({ name: 'Taken', description: 'd' });

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(UnprocessableEntityError);
  });

  it('still wraps an untyped failure as 500', async () => {
    createProject.mockRejectedValueOnce(new Error('mongo exploded') as never);
    const { req, res } = makeReq({ name: 'n', description: 'd' });

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(InternalServerError);
  });
});
