import { describe, expect, it, vi } from 'vitest';
import {
  NotFoundError,
  StudioCompositionCreateInputSchema,
  StudioCompositionUpdateInputSchema,
  UnprocessableEntityError,
  defaultStudioTimeline,
  type IFabFileDocument,
  type IProjectDocument,
  type IStudioComposition,
  type IStudioCompositionDocument,
  type StudioCompositionCreateBody,
  type StudioCompositionUpdateBody,
} from '@bike4mind/common';
import {
  createComposition,
  deleteComposition,
  getComposition,
  listCompositions,
  updateComposition,
} from './operations';
import type { StudioCompositionServiceAdapters } from './ports';

const OWNER = 'user-owner';
const OTHER = 'user-other';
const FILE_MINE = 'a'.repeat(24);
const FILE_THEIRS = 'b'.repeat(24);
const FILE_NEW = 'c'.repeat(24);
const FILE_PDF = 'f'.repeat(24);
const MIME_TYPES: Record<string, string> = {
  [FILE_MINE]: 'video/mp4',
  [FILE_THEIRS]: 'video/mp4',
  [FILE_NEW]: 'image/png',
  [FILE_PDF]: 'application/pdf',
};
const fabFile = (id: string) => ({ id, mimeType: MIME_TYPES[id] }) as IFabFileDocument;
const PROJECT_MINE = 'd'.repeat(24);
const PROJECT_THEIRS = 'e'.repeat(24);

const createFakeAdapters = (readableFileIds: string[] = [FILE_MINE, FILE_NEW, FILE_PDF]) => {
  const rows = new Map<string, IStudioCompositionDocument>();
  let nextId = 0;
  const owned = (id: string, userId: string) => {
    const row = rows.get(id);
    return row && row.userId === userId ? row : null;
  };

  const adapters = {
    db: {
      compositions: {
        createOwned: vi.fn(async (composition: IStudioComposition) => {
          const id = String(++nextId).padStart(24, '0');
          const now = new Date();
          const row = { ...composition, id, createdAt: now, updatedAt: now };
          rows.set(id, row);
          return row;
        }),
        findOwned: vi.fn(async (id: string, userId: string) => owned(id, userId)),
        listOwned: vi.fn(async (userId: string) => [...rows.values()].filter(row => row.userId === userId)),
        updateOwned: vi.fn(async (id: string, userId: string, patch: object, unset: readonly string[] = []) => {
          const row = owned(id, userId);
          if (!row) return null;
          const updated = { ...row, ...patch } as IStudioCompositionDocument & Record<string, unknown>;
          unset.forEach(field => delete updated[field]);
          rows.set(id, updated);
          return updated;
        }),
        deleteOwned: vi.fn(async (id: string, userId: string) => !!owned(id, userId) && rows.delete(id)),
      },
      fabFiles: {
        findAccessibleInIds: vi.fn(async (ids: string[]) =>
          ids.filter(id => readableFileIds.includes(id)).map(fabFile)
        ),
      },
      projects: {
        findByIdAndUserId: vi.fn(async (id: string, userId: string) =>
          id === PROJECT_MINE && userId === OWNER ? ({ id } as IProjectDocument) : null
        ),
      },
    },
  } satisfies StudioCompositionServiceAdapters;
  return adapters;
};

const create = (adapters: StudioCompositionServiceAdapters, body: StudioCompositionCreateBody, userId = OWNER) =>
  createComposition(userId, adapters, StudioCompositionCreateInputSchema.parse(body));

const update = (adapters: StudioCompositionServiceAdapters, id: string, body: StudioCompositionUpdateBody) =>
  updateComposition(OWNER, adapters, id, StudioCompositionUpdateInputSchema.parse(body));

const videoTimeline = (fileId: string) => ({
  ...defaultStudioTimeline('ad_campaign'),
  tracks: [{ id: 'video-1', kind: 'video' as const, clips: [{ id: 'v1', fileId, startMs: 0, durationMs: 5000 }] }],
});

const issueCodes = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(UnprocessableEntityError);
  const { issues } = (error as UnprocessableEntityError).additionalInfo as {
    issues: { code: string; path: unknown[] }[];
  };
  return issues.map(issue => [issue.code, issue.path.join('.')]);
};

describe('createComposition', () => {
  it('owns the composition by the caller and starts the timeline from the template', async () => {
    const adapters = createFakeAdapters();
    const created = await create(adapters, { title: 'Launch', template: 'social_pack' });

    expect(created.userId).toBe(OWNER);
    expect(created.organizationId).toBeUndefined();
    expect(created.timeline).toEqual(defaultStudioTimeline('social_pack'));
    expect(adapters.db.fabFiles.findAccessibleInIds).not.toHaveBeenCalled();
  });

  it("starts with the template's shots when none are sent, and keeps an explicit empty list", async () => {
    const adapters = createFakeAdapters();
    const starter = await create(adapters, { title: 'Launch', template: 'ad_campaign' });
    const empty = await create(adapters, { title: 'Copy', template: 'ad_campaign', shots: [] });

    expect(starter.shots.map(shot => shot.title)).toEqual(['Hook', 'Product', 'Benefit', 'Call to action']);
    expect(empty.shots).toEqual([]);
  });

  it('checks every referenced file against what the caller can read', async () => {
    const adapters = createFakeAdapters();
    const codes = await issueCodes(
      create(adapters, {
        title: 'Launch',
        brandKit: { logoFileId: FILE_THEIRS },
        timeline: videoTimeline(FILE_THEIRS),
      })
    );

    expect(codes).toEqual([
      ['unknown_file', 'timeline.tracks.0.clips.0.fileId'],
      ['unknown_file', 'brandKit.logoFileId'],
    ]);
    expect(adapters.db.fabFiles.findAccessibleInIds).toHaveBeenCalledWith([FILE_THEIRS], { userId: OWNER });
    expect(adapters.db.compositions.createOwned).not.toHaveBeenCalled();
  });

  it('rejects a timeline that breaks the spec rules', async () => {
    const timeline = videoTimeline(FILE_MINE);
    timeline.tracks[0].clips[0].durationMs = 60_000;
    expect(await issueCodes(create(createFakeAdapters(), { title: 'Launch', timeline }))).toEqual([
      ['clip_out_of_bounds', 'timeline.tracks.0.clips.0'],
    ]);
  });

  it('refuses a readable file of a kind its slot cannot play', async () => {
    const timeline = defaultStudioTimeline('ad_campaign');
    const codes = await issueCodes(
      create(createFakeAdapters(), {
        title: 'Launch',
        brandKit: { logoFileId: FILE_MINE },
        timeline: {
          ...timeline,
          tracks: [
            { id: 'music-1', kind: 'music', clips: [{ id: 'm1', fileId: FILE_PDF, startMs: 0, durationMs: 1000 }] },
          ],
        },
      })
    );
    expect(codes).toEqual([
      ['unsupported_file_kind', 'timeline.tracks.0.clips.0.fileId'],
      ['unsupported_file_kind', 'brandKit.logoFileId'],
    ]);
  });

  it('links only a project the caller owns', async () => {
    const adapters = createFakeAdapters();
    expect((await create(adapters, { title: 'Launch', projectId: PROJECT_MINE })).projectId).toBe(PROJECT_MINE);
    await expect(create(adapters, { title: 'Launch', projectId: PROJECT_THEIRS })).rejects.toBeInstanceOf(
      UnprocessableEntityError
    );
  });
});

describe('owner-only access', () => {
  it("answers 404 for another user's composition on get, update and delete", async () => {
    const adapters = createFakeAdapters();
    const created = await create(adapters, { title: 'Launch' });

    await expect(getComposition(OTHER, adapters, created.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateComposition(OTHER, adapters, created.id, StudioCompositionUpdateInputSchema.parse({ title: 'Mine now' }))
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteComposition(OTHER, adapters, created.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getComposition(OWNER, adapters, created.id)).title).toBe('Launch');
  });

  it("lists only the caller's compositions and clamps the page size", async () => {
    const adapters = createFakeAdapters();
    await create(adapters, { title: 'Mine' });
    await create(adapters, { title: 'Theirs' }, OTHER);

    const listed = await listCompositions(OWNER, adapters, { limit: 1000, skip: -5 });
    expect(listed.map(item => item.title)).toEqual(['Mine']);
    expect(adapters.db.compositions.listOwned).toHaveBeenCalledWith(OWNER, { limit: 100, skip: 0 });
  });
});

describe('updateComposition', () => {
  it('keeps an inaccessible stored file valid while requiring access to new ones', async () => {
    const adapters = createFakeAdapters([FILE_MINE, FILE_NEW]);
    const created = await create(adapters, { title: 'Launch', timeline: videoTimeline(FILE_MINE) });
    // The stored file is no longer readable (deleted or unshared since).
    adapters.db.fabFiles.findAccessibleInIds.mockImplementation(async (ids: string[]) =>
      ids.filter(id => id === FILE_NEW).map(fabFile)
    );

    const updated = await update(adapters, created.id, {
      shots: [{ id: 'shot-1', title: 'Open', fileIds: [FILE_NEW] }],
    });
    expect(updated.shots).toHaveLength(1);
    expect(adapters.db.fabFiles.findAccessibleInIds).toHaveBeenLastCalledWith([FILE_NEW, FILE_MINE], { userId: OWNER });
  });

  it('checks the kind of a stored file moved into a slot that cannot play it', async () => {
    const adapters = createFakeAdapters();
    const created = await create(adapters, {
      title: 'Launch',
      shots: [{ id: 'shot-1', title: 'Open', fileIds: [FILE_PDF] }],
    });

    const codes = await issueCodes(
      update(adapters, created.id, { timeline: videoTimeline(FILE_PDF), brandKit: { logoFileId: FILE_PDF } })
    );
    expect(codes).toEqual([
      ['unsupported_file_kind', 'timeline.tracks.0.clips.0.fileId'],
      ['unsupported_file_kind', 'brandKit.logoFileId'],
    ]);
  });

  it('checks a product photo sent in a brief-only edit, but keeps a stored one valid', async () => {
    const adapters = createFakeAdapters([FILE_NEW]);
    const created = await create(adapters, { title: 'Launch', brief: { productFileId: FILE_NEW } });

    expect(await issueCodes(update(adapters, created.id, { brief: { productFileId: FILE_THEIRS } }))).toEqual([
      ['unknown_file', 'brief.productFileId'],
    ]);

    adapters.db.fabFiles.findAccessibleInIds.mockImplementation(async () => []);
    const kept = await update(adapters, created.id, { brief: { productFileId: FILE_NEW, summary: 'Cold brew' } });
    expect(kept.brief).toEqual({ productFileId: FILE_NEW, summary: 'Cold brew' });
  });

  it('checks a new clip file sent in a shots-only edit', async () => {
    const adapters = createFakeAdapters([FILE_NEW]);
    const created = await create(adapters, { title: 'Launch' });

    const codes = await issueCodes(
      update(adapters, created.id, {
        shots: [{ id: 'shot-1', title: 'Open', fileIds: [FILE_NEW], clipFileId: FILE_THEIRS }],
      })
    );
    expect(codes.map(([code]) => code)).toContain('unknown_file');
  });

  it('checks a new logo sent in a brand-kit-only edit', async () => {
    const adapters = createFakeAdapters([FILE_NEW]);
    const created = await create(adapters, { title: 'Launch' });

    expect(await issueCodes(update(adapters, created.id, { brandKit: { logoFileId: FILE_THEIRS } }))).toEqual([
      ['unknown_file', 'brandKit.logoFileId'],
    ]);
  });

  it('skips the file lookup for a content-free edit', async () => {
    const adapters = createFakeAdapters();
    const created = await create(adapters, { title: 'Launch', timeline: videoTimeline(FILE_MINE) });
    adapters.db.fabFiles.findAccessibleInIds.mockClear();

    expect((await update(adapters, created.id, { title: 'Renamed' })).title).toBe('Renamed');
    expect(adapters.db.fabFiles.findAccessibleInIds).not.toHaveBeenCalled();
  });

  it("unlinks a project on null and refuses someone else's project", async () => {
    const adapters = createFakeAdapters();
    const created = await create(adapters, { title: 'Launch', projectId: PROJECT_MINE });

    await expect(update(adapters, created.id, { projectId: PROJECT_THEIRS })).rejects.toBeInstanceOf(
      UnprocessableEntityError
    );
    const unlinked = await update(adapters, created.id, { projectId: null });
    expect(unlinked).not.toHaveProperty('projectId');
    expect(adapters.db.compositions.updateOwned).toHaveBeenLastCalledWith(created.id, OWNER, {}, ['projectId']);
  });
});
