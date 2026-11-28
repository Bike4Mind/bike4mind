import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  canAnnotate,
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  toAnnotationDto,
  toPublishUser,
  updateAnnotation,
  type AnnotationLean,
} from './annotations';
import { AnnotationDtoSchema } from '@bike4mind/common';
import type { PublishUser } from './checkScopePermission';

const db = vi.hoisted(() => ({
  artifact: vi.fn(),
  annotationRows: vi.fn(),
  findFilter: vi.fn(),
  sortArg: vi.fn(),
  limitArg: vi.fn(),
  findOne: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  loadLiveOwner: vi.fn(),
  checkVisibility: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { findOne: () => ({ select: () => ({ lean: db.artifact }) }) },
  Annotation: {
    find: (filter: unknown) => {
      db.findFilter(filter);
      const query: Record<string, unknown> = {
        sort: (s: unknown) => (db.sortArg(s), query),
        limit: (n: unknown) => (db.limitArg(n), query),
        lean: db.annotationRows,
      };
      return query;
    },
    findOne: db.findOne,
    countDocuments: db.count,
    create: db.create,
  },
}));
vi.mock('@server/services/publish', () => ({
  checkVisibility: db.checkVisibility,
  loadLiveOwner: db.loadLiveOwner,
}));

const owner: PublishUser = { id: 'u-owner', username: 'owner', isAdmin: false, organizationId: null };
const viewer: PublishUser = { id: 'u-viewer', username: 'viewer', isAdmin: false, organizationId: null };
const admin: PublishUser = { id: 'u-admin', username: 'admin', isAdmin: true, organizationId: null };

describe('canAnnotate', () => {
  it('always denies anonymous callers regardless of policy', () => {
    expect(canAnnotate({ commentPolicy: 'open', ownerId: 'u-owner' }, undefined, true)).toBe(false);
    expect(canAnnotate({ commentPolicy: 'restricted', ownerId: 'u-owner' }, undefined, true)).toBe(false);
    expect(canAnnotate({ commentPolicy: 'none', ownerId: 'u-owner' }, undefined, true)).toBe(false);
  });

  it('denies everyone when policy is none (read-only)', () => {
    expect(canAnnotate({ commentPolicy: 'none', ownerId: 'u-owner' }, owner, true)).toBe(false);
    expect(canAnnotate({ commentPolicy: 'none', ownerId: 'u-owner' }, admin, true)).toBe(false);
  });

  it('open policy lets any authenticated viewer who passed the visibility gate', () => {
    expect(canAnnotate({ commentPolicy: 'open', ownerId: 'u-owner' }, viewer, true)).toBe(true);
    // but not if they failed the visibility gate
    expect(canAnnotate({ commentPolicy: 'open', ownerId: 'u-owner' }, viewer, false)).toBe(false);
  });

  it('restricted policy is owner/admin only (allowlist deferred)', () => {
    expect(canAnnotate({ commentPolicy: 'restricted', ownerId: 'u-owner' }, owner, true)).toBe(true);
    expect(canAnnotate({ commentPolicy: 'restricted', ownerId: 'u-owner' }, admin, true)).toBe(true);
    expect(canAnnotate({ commentPolicy: 'restricted', ownerId: 'u-owner' }, viewer, true)).toBe(false);
  });
});

describe('toPublishUser', () => {
  it('returns undefined when there is no user id', () => {
    expect(toPublishUser(undefined)).toBeUndefined();
  });

  it('narrows an Express user to the PublishUser shape', () => {
    const u = { id: 'u1', username: 'bob', isAdmin: true, organizationId: 'org1' } as unknown as Express.User;
    expect(toPublishUser(u)).toEqual({ id: 'u1', username: 'bob', isAdmin: true, organizationId: 'org1' });
  });
});

describe('toAnnotationDto', () => {
  it('serializes dates to ISO strings and never leaks internal fields', () => {
    const created = new Date('2026-06-16T12:00:00.000Z');
    const row: AnnotationLean = {
      _id: { toString: () => 'a1' },
      publicId: 'pub1',
      kind: 'comment',
      authorId: 'u1',
      authorDisplayName: 'Bob',
      body: 'looks great',
      anchor: { x: 0.5, y: 0.25 },
      threadRootId: null,
      createdAt: created,
      resolvedAt: null,
    };
    const dto = toAnnotationDto(row);
    expect(dto).toMatchObject({
      id: 'a1',
      publicId: 'pub1',
      kind: 'comment',
      body: 'looks great',
      anchor: { x: 0.5, y: 0.25 },
      createdAt: '2026-06-16T12:00:00.000Z',
      resolvedAt: null,
    });
    // No deletedAt / deletedBy / updatedAt leak into the public DTO.
    expect(Object.keys(dto)).not.toContain('deletedAt');
    expect(Object.keys(dto)).not.toContain('deletedBy');
    expect(Object.keys(dto)).not.toContain('authorId');
  });

  it('returns anchor.elementText when stored and an anchor without it for a legacy row', () => {
    const base: AnnotationLean = {
      _id: { toString: () => 'a2' },
      publicId: 'pub1',
      kind: 'comment',
      authorId: 'u1',
      authorDisplayName: 'Bob',
      body: 'hi',
      threadRootId: null,
      createdAt: new Date('2026-06-16T12:00:00.000Z'),
      resolvedAt: null,
    };
    const withText = toAnnotationDto({ ...base, anchor: { x: 0.1, y: 0.2, elementText: 'Pricing' } });
    expect(withText.anchor).toEqual({ x: 0.1, y: 0.2, elementText: 'Pricing' });
    expect(AnnotationDtoSchema.parse(withText).anchor?.elementText).toBe('Pricing');

    const legacy = toAnnotationDto({ ...base, anchor: { x: 0.1, y: 0.2 } });
    expect(legacy.anchor).toEqual({ x: 0.1, y: 0.2 });
    expect(AnnotationDtoSchema.safeParse(legacy).success).toBe(true);
    expect(toAnnotationDto(base).anchor).toBeUndefined();
  });
});

describe('annotation services', () => {
  const logger = { info: vi.fn() };
  const artifactDoc = {
    publicId: 'pub1',
    visibility: 'public',
    ownerId: 'u-owner',
    scopeId: 's1',
    commentPolicy: 'open',
    sha256Index: 'sha',
    accessGate: null,
  };
  const expressUser = (u: PublishUser) => u as unknown as Express.User;
  const rejection = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e as Record<string, unknown>
    );

  beforeEach(() => {
    vi.clearAllMocks();
    db.artifact.mockResolvedValue(artifactDoc);
    db.loadLiveOwner.mockResolvedValue({});
    db.checkVisibility.mockResolvedValue({ ok: true });
    db.annotationRows.mockResolvedValue([]);
    db.count.mockResolvedValue(0);
  });

  it('lists for an anonymous viewer and marks only open-public lists cacheable', async () => {
    expect(await listAnnotations({ publicId: 'pub1' })).toEqual({
      annotations: [],
      hasMore: false,
      commentPolicy: 'open',
      cacheable: true,
    });
    db.artifact.mockResolvedValue({ ...artifactDoc, accessGate: { kind: 'passphrase' } });
    expect((await listAnnotations({ publicId: 'pub1' })).cacheable).toBe(false);
  });

  it('pages by keyset: asks for one extra row and reports hasMore', async () => {
    const row = (id: string) => ({
      _id: id,
      publicId: 'pub1',
      kind: 'comment',
      body: 'x',
      createdAt: new Date('2026-10-02'),
    });
    db.annotationRows.mockResolvedValue([row('a'), row('b'), row('c')]);
    const result = await listAnnotations({ publicId: 'pub1', page: { limit: 2 } });
    expect(result.annotations.map(a => a.id)).toEqual(['a', 'b']);
    expect(result.hasMore).toBe(true);
    db.annotationRows.mockResolvedValue([row('c')]);
    expect((await listAnnotations({ publicId: 'pub1', page: { limit: 2 } })).hasMore).toBe(false);
  });

  it('builds the keyset query: $or on createdAt then _id, id tie-break sort, limit + 1', async () => {
    db.annotationRows.mockResolvedValue([]);
    db.findFilter.mockClear();
    db.sortArg.mockClear();
    db.limitArg.mockClear();
    const at = new Date('2026-10-02');
    await listAnnotations({ publicId: 'pub1', page: { limit: 2, after: { at, id: 'a' } } });
    expect(db.findFilter).toHaveBeenCalledWith({
      publicId: 'pub1',
      deletedAt: null,
      $or: [{ createdAt: { $gt: at } }, { createdAt: at, _id: { $gt: 'a' } }],
    });
    expect(db.sortArg).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
    expect(db.limitArg).toHaveBeenCalledWith(3);
  });

  it('keeps the legacy unpaged query on the createdAt index sort with no limit', async () => {
    db.annotationRows.mockResolvedValue([]);
    db.findFilter.mockClear();
    db.sortArg.mockClear();
    db.limitArg.mockClear();
    await listAnnotations({ publicId: 'pub1' });
    expect(db.findFilter).toHaveBeenCalledWith({ publicId: 'pub1', deletedAt: null });
    expect(db.sortArg).toHaveBeenCalledWith({ createdAt: 1 });
    expect(db.limitArg).not.toHaveBeenCalled();
  });

  it('passes the gate proof to the visibility check only for passphrase gates', async () => {
    db.artifact.mockResolvedValue({ ...artifactDoc, accessGate: { kind: 'passphrase' } });
    await listAnnotations({ publicId: 'pub1', hasGateProof: true });
    expect(db.checkVisibility.mock.calls[0][2]).toEqual({ passphraseVerified: true });
    db.artifact.mockResolvedValue({ ...artifactDoc, accessGate: { kind: 'domain' } });
    await listAnnotations({ publicId: 'pub1', hasGateProof: true });
    expect(db.checkVisibility.mock.calls[1][2]).toEqual({ passphraseVerified: false });
  });

  it('throws 404 not_found when the artifact or its owner is gone', async () => {
    db.loadLiveOwner.mockResolvedValue(null);
    expect(await rejection(listAnnotations({ publicId: 'pub1' }))).toMatchObject({
      statusCode: 404,
      additionalInfo: { errorCode: 'not_found' },
    });
  });

  it('throws the visibility status when the gate refuses', async () => {
    db.checkVisibility.mockResolvedValue({ ok: false, status: 401, error: 'Passphrase required' });
    expect(await rejection(listAnnotations({ publicId: 'pub1' }))).toMatchObject({
      statusCode: 401,
      message: 'Passphrase required',
    });
  });

  it('create requires a user, a comment kind and a permitting policy', async () => {
    const input = { body: 'hi' };
    expect(await rejection(createAnnotation({ publicId: 'pub1', input, logger }))).toMatchObject({ statusCode: 401 });
    expect(
      await rejection(
        createAnnotation({ user: expressUser(viewer), publicId: 'pub1', input: { ...input, kind: 'vote' }, logger })
      )
    ).toMatchObject({ statusCode: 400, additionalInfo: { errorCode: 'unsupported_annotation_kind' } });
    db.artifact.mockResolvedValue({ ...artifactDoc, commentPolicy: 'none' });
    expect(
      await rejection(createAnnotation({ user: expressUser(viewer), publicId: 'pub1', input, logger }))
    ).toMatchObject({
      statusCode: 403,
      message: 'Commenting is disabled for this artifact',
      additionalInfo: { errorCode: 'comments_disabled' },
    });
  });

  it('create throttles non-admins and exempts admins', async () => {
    db.count.mockResolvedValue(30);
    const input = { body: 'hi' };
    expect(
      await rejection(createAnnotation({ user: expressUser(viewer), publicId: 'pub1', input, logger }))
    ).toMatchObject({ statusCode: 429, additionalInfo: { errorCode: 'comment_rate_limited' } });
    db.create.mockResolvedValue({
      id: 'a1',
      toObject: () => ({ _id: 'a1', publicId: 'pub1', kind: 'comment', createdAt: new Date(0) }),
    });
    await createAnnotation({ user: expressUser(admin), publicId: 'pub1', input, logger });
    expect(db.count).toHaveBeenCalledTimes(1);
  });

  it('create pins the artifact version, validates the thread root and logs', async () => {
    db.create.mockResolvedValue({
      id: 'a1',
      toObject: () => ({ _id: 'a1', publicId: 'pub1', kind: 'comment', createdAt: new Date(0) }),
    });
    const dto = await createAnnotation({ user: expressUser(viewer), publicId: 'pub1', input: { body: 'hi' }, logger });
    expect(dto.id).toBe('a1');
    expect(db.create).toHaveBeenCalledWith(
      expect.objectContaining({ artifactVersionSha: 'sha', authorId: 'u-viewer' })
    );
    expect(logger.info).toHaveBeenCalledWith('[ANNOTATE] create publicId=pub1 by=u-viewer id=a1');
    expect(
      await rejection(
        createAnnotation({
          user: expressUser(viewer),
          publicId: 'pub1',
          input: { body: 'x', threadRootId: 'nope' },
          logger,
        })
      )
    ).toMatchObject({ statusCode: 400, additionalInfo: { errorCode: 'invalid_thread_root' } });
  });

  describe('update and delete', () => {
    const id = 'a'.repeat(24);
    const row = (authorId: string) => ({
      authorId,
      body: 'old',
      resolvedAt: null as Date | null,
      resolvedBy: null as string | null,
      save: vi.fn(),
      softDelete: vi.fn(),
      toObject() {
        return { _id: id, publicId: 'pub1', kind: 'comment', body: this.body, createdAt: new Date(0) };
      },
    });

    it('only the author may edit the body', async () => {
      db.findOne.mockResolvedValue(row('u-viewer'));
      expect(
        await rejection(updateAnnotation({ user: expressUser(admin), publicId: 'pub1', id, input: { body: 'new' } }))
      ).toMatchObject({ statusCode: 403, additionalInfo: { errorCode: 'author_only' } });
      const dto = await updateAnnotation({ user: expressUser(viewer), publicId: 'pub1', id, input: { body: 'new' } });
      expect(dto.body).toBe('new');
    });

    it('lets the artifact owner resolve but not an unrelated viewer', async () => {
      const ann = row('u-viewer');
      db.findOne.mockResolvedValue(ann);
      db.artifact.mockResolvedValue({ ownerId: 'u-owner' });
      await updateAnnotation({ user: expressUser(owner), publicId: 'pub1', id, input: { resolved: true } });
      expect(ann.resolvedBy).toBe('u-owner');
      const other = { ...viewer, id: 'u-other' };
      expect(
        await rejection(updateAnnotation({ user: expressUser(other), publicId: 'pub1', id, input: { resolved: true } }))
      ).toMatchObject({ statusCode: 403 });
    });

    it('404s a malformed or unknown id', async () => {
      expect(
        await rejection(deleteAnnotation({ user: expressUser(viewer), publicId: 'pub1', id: 'bad', logger }))
      ).toMatchObject({ statusCode: 404 });
    });

    it('soft-deletes for the author and logs', async () => {
      const ann = row('u-viewer');
      db.findOne.mockResolvedValue(ann);
      await deleteAnnotation({ user: expressUser(viewer), publicId: 'pub1', id, logger });
      expect(ann.softDelete).toHaveBeenCalledWith('u-viewer');
      expect(logger.info).toHaveBeenCalledWith(`[ANNOTATE] delete publicId=pub1 id=${id} by=u-viewer`);
    });
  });
});
