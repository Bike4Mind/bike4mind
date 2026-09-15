import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, getDataLakeTags, TagType } from '@bike4mind/common';

/**
 * Route-layer coverage for /api/files/tags. The service decides how to fold counts into tags and
 * whether a name is already taken; the route decides what scope and what tag type to hand it, and
 * getting that wrong (owner-only counts, raw user tags forwarded as data-lake tags, a body that
 * overrides the type) makes the sidebar badge disagree with the tag tree or turns a refusal into a
 * 500. Only a route-level test can catch that, so this asserts the wiring matches the sibling
 * counts.ts.
 */

// Collapse the baseApi().post().get() chain and capture both handlers.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
  listArgs: undefined as unknown[] | undefined,
  createArgs: undefined as unknown[] | undefined,
  createResult: undefined as unknown,
  createError: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  fileTagRepository: { __repo: 'fileTags' },
  fabFileRepository: { __repo: 'fabFiles' },
}));

vi.mock('@bike4mind/services', () => ({
  tagService: {
    create: (...args: unknown[]) => {
      mockRefs.createArgs = args;
      return mockRefs.createError ? Promise.reject(mockRefs.createError) : Promise.resolve(mockRefs.createResult);
    },
    listFileTags: (...args: unknown[]) => {
      mockRefs.listArgs = args;
      return Promise.resolve([]);
    },
  },
}));

// Import after mocks are registered so the chain capture runs.
import '@pages/api/files/tags/index';

// `Opti` is the requiredUserTag of the only lake in the DATA_LAKES registry, so getDataLakeTags
// resolves to a non-empty set here. Without it every assertion below passes vacuously on [].
const USER_TAGS = ['Opti', 'some-arbitrary-tag'];
const GRANTED_LAKE_TAG = 'datalake:opti-knowledge';

function invokeGet(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', url: '/api/files/tags' });
  (req as any).user = user;
  return { req, res };
}

function invokePost(user: Record<string, unknown>, body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', url: '/api/files/tags', body });
  (req as any).user = user;
  return { req, res };
}

describe('POST /api/files/tags', () => {
  beforeEach(() => {
    mockRefs.createArgs = undefined;
    mockRefs.createError = undefined;
    mockRefs.createResult = { id: 'tag-1', name: 'invoices' };
  });

  it('forwards the caller id and the submitted fields to the service', async () => {
    expect(mockRefs.postHandler).toBeTypeOf('function');
    const { req, res } = invokePost({ id: 'user-1' }, { name: 'invoices', color: '#FF0000' });

    await mockRefs.postHandler!(req, res);

    expect(mockRefs.createArgs?.[0]).toBe('user-1');
    expect(mockRefs.createArgs?.[1]).toEqual({ name: 'invoices', color: '#FF0000', type: TagType.FILE });
    expect(res._getJSONData()).toEqual({ id: 'tag-1', name: 'invoices' });
  });

  // The type injection has to WIN over the body. Spread last, a caller could send
  // `type: 'session'`, which this route has no branch for and which the service refuses with a
  // plain Error - a 500 driven by user input.
  it('does not let the body override the tag type', async () => {
    const { req, res } = invokePost({ id: 'user-1' }, { name: 'invoices', type: 'session' });

    await mockRefs.postHandler!(req, res);

    expect((mockRefs.createArgs?.[1] as { type: string }).type).toBe(TagType.FILE);
  });

  it('passes the tag repository the service needs for the collision lookup', async () => {
    const { req, res } = invokePost({ id: 'user-1' }, { name: 'invoices' });

    await mockRefs.postHandler!(req, res);

    expect(mockRefs.createArgs?.[2]).toEqual({ db: { fileTags: { __repo: 'fileTags' } } });
  });

  // A refused name must reach errorHandler, which reads statusCode off the HTTPError. Answering 200
  // with the rejection swallowed would leave the client believing the tag was created.
  it('propagates a refusal instead of answering with a success payload', async () => {
    mockRefs.createError = new BadRequestError('Tag Service - Create: you already have a tag named "invoices"');
    const { req, res } = invokePost({ id: 'user-1' }, { name: 'INVOICES' });

    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(res._isEndCalled()).toBe(false);
  });

  it('rejects an unauthenticated caller before touching the service', async () => {
    const { req, res } = invokePost({}, { name: 'invoices' });

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(mockRefs.createArgs).toBeUndefined();
  });
});

describe('GET /api/files/tags', () => {
  beforeEach(() => {
    mockRefs.listArgs = undefined;
  });

  it('scopes counts to the caller groups and their accessible data lakes', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');
    const { req, res } = invokeGet({ id: 'user-1', groups: ['group-a'], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.listArgs?.[0]).toBe('user-1');
    expect(mockRefs.listArgs?.[1]).toEqual({
      userGroups: ['group-a'],
      dataLakeTags: getDataLakeTags(USER_TAGS),
    });
  });

  it('derives data-lake tags rather than forwarding the raw user tags', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: [], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    const { dataLakeTags } = mockRefs.listArgs?.[1] as { dataLakeTags: string[] };
    expect(dataLakeTags).toContain(GRANTED_LAKE_TAG);
    expect(dataLakeTags).not.toContain('some-arbitrary-tag');
    expect(dataLakeTags).not.toContain('Opti');
  });

  // dataLakeTags is an ownership-bypass arm in buildOwnershipConditions, so a caller who holds no
  // lake-granting tag must widen the count scope by nothing at all.
  it('grants no lake scope to a caller without the gating tag', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: [], tags: ['some-arbitrary-tag'] });

    await mockRefs.getHandler!(req, res);

    expect((mockRefs.listArgs?.[1] as { dataLakeTags: string[] }).dataLakeTags).toEqual([]);
  });

  it('passes both repositories the service needs to recompute counts', async () => {
    const { req, res } = invokeGet({ id: 'user-1', groups: ['group-a'], tags: USER_TAGS });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.listArgs?.[2]).toEqual({
      db: { fileTags: { __repo: 'fileTags' }, fabFiles: { __repo: 'fabFiles' } },
    });
  });

  it('defaults missing groups and tags to empty rather than passing undefined', async () => {
    const { req, res } = invokeGet({ id: 'user-1' });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.listArgs?.[1]).toEqual({ userGroups: [], dataLakeTags: getDataLakeTags([]) });
  });

  it('rejects an unauthenticated caller before touching the service', async () => {
    const { req, res } = invokeGet({});

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow();
    expect(mockRefs.listArgs).toBeUndefined();
  });
});
