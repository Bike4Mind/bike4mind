import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_MODEL_CATALOG, type IUserDocument, type ImageModels } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { ImageToolConfig, MusicToolConfig, VideoToolConfig } from '@bike4mind/services/llm/tools';

// The production deps factory pulls in the DB and job wiring; these tests drive the pure builder.
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: {},
  generationJobRepository: {},
  projectRepository: {},
  studioCompositionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  studioCompositionService: { getComposition: vi.fn(), updateComposition: vi.fn() },
}));
vi.mock('@bike4mind/server-utils/generationJobs/wiring', () => ({ getImageJobDeps: vi.fn() }));
vi.mock('@bike4mind/server-utils/imageGenerations/listUsableImageModels', () => ({ listUsableImageModels: vi.fn() }));
vi.mock('@bike4mind/server-utils/middlewares/studioFeatureFlag', () => ({ isStudioFeatureEnabled: vi.fn() }));

const { studioCompositionService } = await import('@bike4mind/services');
const { buildAgentProductionToolConfig, productionToolsOpen } = await import('./agentExecutor.productionToolConfig');
type Deps = Parameters<typeof buildAgentProductionToolConfig>[1];
type Input = Parameters<typeof buildAgentProductionToolConfig>[0];

const catalogIds = Object.keys(IMAGE_MODEL_CATALOG) as ImageModels[];
const takesReference = (id: ImageModels) => (IMAGE_MODEL_CATALOG[id].modes.generate?.inputs.reference?.max ?? 0) > 0;
const referenceModels = catalogIds.filter(takesReference);
const REFERENCE_MODEL = referenceModels[0] as string;
const OTHER_REFERENCE_MODEL = referenceModels[1] as string;
const PLAIN_MODEL = catalogIds.find(id => !takesReference(id)) as string;

const USER = { id: 'user-1', isAdmin: false } as unknown as IUserDocument;
const image = { selection: undefined, createJobs: vi.fn() } as unknown as ImageToolConfig;
const video = { usableModels: [], createJob: vi.fn() } as unknown as VideoToolConfig;
const music = { usableModels: [], createJob: vi.fn() } as unknown as MusicToolConfig;

const makeLogger = () => ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

const makeInput = (overrides: Partial<Input> = {}): Input => ({
  user: USER,
  questId: 'quest-1',
  toolEnabled: true,
  image,
  video,
  music,
  ...overrides,
});

const adapters = { db: {} } as unknown as Deps['compositionAdapters'];

const makeDeps = (overrides: Partial<Deps> = {}): Deps & { logger: ReturnType<typeof makeLogger> } => ({
  isEnabled: vi.fn(async () => true),
  compositionAdapters: adapters,
  findJob: vi.fn(async () => null),
  listReferenceImageModels: vi.fn(async () => [REFERENCE_MODEL, OTHER_REFERENCE_MODEL]),
  logger: makeLogger(),
  ...overrides,
});

describe('buildAgentProductionToolConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has real catalog models to test with', () => {
    expect(referenceModels.length).toBeGreaterThanOrEqual(2);
    expect(PLAIN_MODEL).toBeDefined();
  });

  describe('is not offered (null) when', () => {
    it.each([
      ['the toolbelt names no production tool', { toolEnabled: false }],
      ['an API key started the run', { apiKeyId: 'key-1' }],
      ['there is no quest to attach job cards to', { questId: undefined }],
      ['there is no image config', { image: null }],
    ])('%s', async (_label, overrides) => {
      const deps = makeDeps();
      await expect(buildAgentProductionToolConfig(makeInput(overrides as Partial<Input>), deps)).resolves.toBeNull();
      expect(deps.isEnabled).not.toHaveBeenCalled();
      expect(deps.listReferenceImageModels).not.toHaveBeenCalled();
    });

    it('the Productions flag is closed to the user', async () => {
      const deps = makeDeps({ isEnabled: vi.fn(async () => false) });
      await expect(buildAgentProductionToolConfig(makeInput(), deps)).resolves.toBeNull();
      expect(deps.isEnabled).toHaveBeenCalledWith(USER);
      expect(deps.listReferenceImageModels).not.toHaveBeenCalled();
    });

    it('the flag check throws: fails closed and warns', async () => {
      const deps = makeDeps({
        isEnabled: vi.fn(async () => {
          throw new Error('settings down');
        }),
      });
      await expect(buildAgentProductionToolConfig(makeInput(), deps)).resolves.toBeNull();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('tools not offered'),
        expect.objectContaining({ error: 'settings down' })
      );
    });

    it('listing the usable models throws: fails closed and warns', async () => {
      const deps = makeDeps({
        listReferenceImageModels: vi.fn(async () => {
          throw new Error('key lookup failed');
        }),
      });
      await expect(buildAgentProductionToolConfig(makeInput(), deps)).resolves.toBeNull();
      expect(deps.logger.warn).toHaveBeenCalledOnce();
    });
  });

  describe('when offered', () => {
    it('passes through the capped image, video and music configs and the audio settings with the audio jobs', async () => {
      const audioSettings = { voice: 'nova' } as never;
      const audioJobs = { createSpeechJob: vi.fn() } as never;
      const config = await buildAgentProductionToolConfig(makeInput({ audioSettings, audioJobs }), makeDeps());
      expect(config).toMatchObject({ image, video, music });
      expect(config?.audio).toEqual({ voice: 'nova', jobs: audioJobs });
    });

    it('leaves voiceover and sound effects unavailable without the audio jobs', async () => {
      const config = await buildAgentProductionToolConfig(makeInput({ audioSettings: {} }), makeDeps());
      expect(config?.audio).toBeNull();
    });

    it("puts the user's selected model first when it takes references", async () => {
      const deps = makeDeps();
      const config = await buildAgentProductionToolConfig(
        makeInput({ imageSelection: { model: OTHER_REFERENCE_MODEL } as never }),
        deps
      );
      expect(deps.listReferenceImageModels).toHaveBeenCalledWith(USER.id);
      expect(config?.imageModels).toEqual([OTHER_REFERENCE_MODEL, REFERENCE_MODEL]);
    });

    it('keeps the usable order when the selected model cannot take references', async () => {
      const config = await buildAgentProductionToolConfig(
        makeInput({ imageSelection: { model: PLAIN_MODEL } as never }),
        makeDeps()
      );
      expect(config?.imageModels).toEqual([REFERENCE_MODEL, OTHER_REFERENCE_MODEL]);
    });

    it('keeps the usable order for an unknown selected model or no selection', async () => {
      const unknown = await buildAgentProductionToolConfig(
        makeInput({ imageSelection: { model: 'not-in-the-catalog' } as never }),
        makeDeps()
      );
      const none = await buildAgentProductionToolConfig(makeInput(), makeDeps());
      expect(unknown?.imageModels).toEqual([REFERENCE_MODEL, OTHER_REFERENCE_MODEL]);
      expect(none?.imageModels).toEqual([REFERENCE_MODEL, OTHER_REFERENCE_MODEL]);
    });

    describe('findJobs', () => {
      it("drops another user's jobs and missing ones, and maps output and error", async () => {
        const records = {
          mine: {
            id: 'mine',
            requestedBy: USER.id,
            state: 'succeeded' as const,
            payload: { output: { fileId: 'f'.repeat(24), durationSeconds: 7 } },
          },
          failed: {
            id: 'failed',
            requestedBy: USER.id,
            state: 'failed' as const,
            error: { message: 'content blocked' },
          },
          theirs: {
            id: 'theirs',
            requestedBy: 'user-2',
            state: 'succeeded' as const,
            payload: { output: { fileId: 'e'.repeat(24) } },
          },
        };
        const findJob = vi.fn(async (id: string) => (records as Record<string, (typeof records)['mine']>)[id] ?? null);
        const config = await buildAgentProductionToolConfig(makeInput(), makeDeps({ findJob }));

        const views = await config!.findJobs(['mine', 'theirs', 'failed', 'gone']);

        expect(views.map(view => view.id)).toEqual(['mine', 'failed']);
        expect(views[0]).toEqual({ id: 'mine', state: 'succeeded', fileId: 'f'.repeat(24), durationSeconds: 7 });
        expect(views[1]).toEqual({
          id: 'failed',
          state: 'failed',
          error: { code: 'job_failed', message: 'content blocked' },
        });
      });

      it('keeps a zero durationSeconds and omits absent output fields', async () => {
        const findJob = vi.fn(async () => ({
          id: 'a',
          requestedBy: USER.id,
          state: 'running' as const,
          payload: { output: { durationSeconds: 0 } },
        }));
        const config = await buildAgentProductionToolConfig(makeInput(), makeDeps({ findJob }));
        expect(await config!.findJobs(['a'])).toEqual([{ id: 'a', state: 'running', durationSeconds: 0 }]);
      });
    });

    describe('compositions', () => {
      it('reads through the composition service as the run user', async () => {
        const composition = { id: 'c1' };
        vi.mocked(studioCompositionService.getComposition).mockResolvedValue(composition as never);
        const config = await buildAgentProductionToolConfig(makeInput(), makeDeps());

        await expect(config!.compositions.get('c1')).resolves.toBe(composition);
        expect(studioCompositionService.getComposition).toHaveBeenCalledWith(USER.id, adapters, 'c1');
      });

      it('writes through the composition service as the run user', async () => {
        const updated = { id: 'c1' };
        vi.mocked(studioCompositionService.updateComposition).mockResolvedValue(updated as never);
        const config = await buildAgentProductionToolConfig(makeInput(), makeDeps());
        const patch = { shots: [] };

        await expect(config!.compositions.update('c1', patch)).resolves.toBe(updated);
        expect(studioCompositionService.updateComposition).toHaveBeenCalledWith(USER.id, adapters, 'c1', patch);
      });
    });

    describe('referenceImages', () => {
      type File = { id: string; userId: string; mimeType: string; filePath: string; moderationStatus: string };
      const withFiles = (files: File[]) => {
        const findAccessibleInIds = vi.fn(async () => files);
        const deps = makeDeps({
          compositionAdapters: { db: { fabFiles: { findAccessibleInIds } } } as unknown as Deps['compositionAdapters'],
        });
        return { deps, findAccessibleInIds };
      };
      const file = (id: string, overrides: Partial<File> = {}): File => ({
        id,
        userId: USER.id,
        mimeType: 'image/png',
        filePath: `files/${id}`,
        moderationStatus: 'clean',
        ...overrides,
      });

      it('keeps only the files an image job takes from the run user as references', async () => {
        const { deps, findAccessibleInIds } = withFiles([
          file('photo'),
          file('fresh', { moderationStatus: 'pending' }),
          file('shared', { userId: 'someone-else' }),
          file('clip', { mimeType: 'video/mp4' }),
          file('gif', { mimeType: 'image/gif' }),
          file('blocked', { moderationStatus: 'blocked' }),
        ]);
        const config = await buildAgentProductionToolConfig(makeInput(), deps);
        const ids = ['photo', 'fresh', 'shared', 'clip', 'gif', 'blocked', 'gone'];

        const states = await config!.referenceImages(ids);

        expect(findAccessibleInIds).toHaveBeenCalledWith(ids, { userId: USER.id });
        expect([...states]).toEqual([
          ['photo', 'ready'],
          ['fresh', 'checking'],
        ]);
      });

      it('reads nothing for no ids', async () => {
        const { deps, findAccessibleInIds } = withFiles([]);
        const config = await buildAgentProductionToolConfig(makeInput(), deps);

        expect((await config!.referenceImages([])).size).toBe(0);
        expect(findAccessibleInIds).not.toHaveBeenCalled();
      });
    });
  });
});

describe('productionToolsOpen', () => {
  it('reads the flag only for a run that could be offered the tools', async () => {
    const deps = makeDeps();
    await expect(productionToolsOpen(makeInput({ apiKeyId: 'key-1' }), deps)).resolves.toBe(false);
    await expect(productionToolsOpen(makeInput({ toolEnabled: false }), deps)).resolves.toBe(false);
    expect(deps.isEnabled).not.toHaveBeenCalled();
    await expect(productionToolsOpen(makeInput(), deps)).resolves.toBe(true);
    expect(deps.isEnabled).toHaveBeenCalledWith(USER);
  });

  it('fails closed and warns when the flag check throws', async () => {
    const deps = makeDeps({
      isEnabled: vi.fn(async () => {
        throw new Error('settings down');
      }),
    });
    await expect(productionToolsOpen(makeInput(), deps)).resolves.toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledOnce();
  });
});
