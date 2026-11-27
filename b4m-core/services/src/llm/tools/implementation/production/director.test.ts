import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_MODEL_CATALOG,
  insufficientCreditsError,
  NotFoundError,
  UnprocessableEntityError,
  defaultStudioTimeline,
  studioCompositionFileIds,
  validateStudioComposition,
  type ImageModels,
  type StudioCompositionUpdateInput,
  type StudioFileMediaKind,
} from '@bike4mind/common';
import type { ToolContext } from '../../base/types';
import type { ImageToolConfig } from '../imageGeneration/imageJobTool';
import type { MusicToolConfig } from '../musicGeneration';
import type { VideoToolConfig } from '../videoGeneration';
import type { ProductionAudioAdapter, ProductionComposition, ProductionJobView, ProductionToolConfig } from './config';
import {
  productionAddAudioTool,
  productionAssembleTool,
  productionGenerateShotTool,
  productionStoryboardTool,
} from './index';
import { createProductionAudio } from './audio';
import { DIRECTOR_TRACK_IDS, directorClips } from './layout';
import { STORYBOARD_MAX_SHOTS } from './storyboard';
import { ProductionToolError, describeProductionError } from './shared';

vi.mock('./audio', () => ({ createProductionAudio: vi.fn() }));

const COMPOSITION_ID = '5'.repeat(24);
const PRODUCT_FILE_ID = 'ab'.repeat(12);

const referenceCap = (id: ImageModels) => IMAGE_MODEL_CATALOG[id].modes.generate?.inputs.reference?.max ?? 0;
const imageModelWith = (fits: (cap: number) => boolean): ImageModels => {
  const model = (Object.keys(IMAGE_MODEL_CATALOG) as ImageModels[]).find(id => fits(referenceCap(id)));
  if (!model) throw new Error('the image catalog has no model with the reference cap this test needs');
  return model;
};
const referenceModel = imageModelWith(cap => cap > 0);
const singleReferenceModel = imageModelWith(cap => cap === 1);
const multiReferenceModel = imageModelWith(cap => cap > 1);

type Harness = {
  config: ProductionToolConfig;
  context: ToolContext;
  statusUpdate: ReturnType<typeof vi.fn>;
  composition(): ProductionComposition;
  counts: { image: number; video: number; music: number; speech: number; sfx: number };
  imageRequests: { request: unknown; count: number }[];
  /** The state each new image job lands in; a job that is not succeeded saves no file. */
  imageState: { next: (request: unknown) => 'succeeded' | 'running' | 'failed' };
  /** Finishes every running image job with a new file, as the job runner would after a call stopped waiting. */
  finishRunningImages(): void;
  /** A new file the user can read, of the given kind. */
  addFile(kind: StudioFileMediaKind): string;
};

/** An in-memory production: the real validator guards every write, as the real composition service does. */
// File ids stay unique across tests: product look bookkeeping in productLook.ts is module-level, keyed by file id.
let nextFile = 1;

function createHarness(): Harness {
  const newFileId = () => (nextFile++).toString(16).padStart(24, '0');
  const knownFileIds = new Set<string>([PRODUCT_FILE_ID]);
  const kinds = new Map<string, StudioFileMediaKind>([[PRODUCT_FILE_ID, 'image']]);
  const makeFile = (kind: StudioFileMediaKind = 'image') => {
    const id = newFileId();
    knownFileIds.add(id);
    kinds.set(id, kind);
    return id;
  };
  const jobs = new Map<string, ProductionJobView>();
  const counts = { image: 0, video: 0, music: 0, speech: 0, sfx: 0 };
  const imageRequests: Harness['imageRequests'] = [];
  let nextJob = 1;
  const imageState: Harness['imageState'] = { next: () => 'succeeded' };
  const startJob = (kind: 'image' | 'video' | 'music', durationSeconds?: number, request?: unknown) => {
    const id = `job-${kind}-${nextJob++}`;
    const state = kind === 'image' ? imageState.next(request) : 'succeeded';
    jobs.set(id, {
      id,
      state,
      ...(state === 'succeeded' && { fileId: makeFile(kind === 'music' ? 'audio' : kind) }),
      ...(state === 'failed' && { error: { code: 'provider_error', message: 'the model refused' } }),
      ...(durationSeconds !== undefined && { durationSeconds }),
    });
    counts[kind] += 1;
    return id;
  };

  let stored: ProductionComposition = {
    id: COMPOSITION_ID,
    title: 'Spring ad',
    template: 'blank',
    brief: {},
    brandKit: { colors: ['#112233'], productFileIds: [], characters: [] },
    shots: [],
    timeline: defaultStudioTimeline('blank'),
  };

  // Replays a key it has seen, as the real image job service does.
  const imageJobsByKey = new Map<string, string[]>();
  const image: ImageToolConfig = {
    selection: undefined,
    createJobs: async input => {
      const key = input.idempotencyKey;
      const replayed = key ? imageJobsByKey.get(key) : undefined;
      if (replayed) {
        const replayJobs = replayed.map(id => ({ id, state: (jobs.get(id) as ProductionJobView).state }));
        return { ok: true, groupId: 'group', jobs: replayJobs, created: false } as never;
      }
      imageRequests.push({ request: input.request, count: input.count });
      const ids = Array.from({ length: input.count }, () => startJob('image', undefined, input.request));
      if (key) imageJobsByKey.set(key, ids);
      return { ok: true, groupId: 'group', jobs: ids.map(id => ({ id })), created: true } as never;
    },
  };
  const finishRunningImages = () => {
    for (const job of jobs.values()) {
      if (job.id.startsWith('job-image-') && job.state === 'running') {
        jobs.set(job.id, { ...job, state: 'succeeded', fileId: makeFile('image') });
      }
    }
  };
  const video: VideoToolConfig = {
    usableModels: ['test-video'],
    createJob: async input => {
      const { durationSeconds } = input.request as { durationSeconds: number };
      return { ok: true, job: { id: startJob('video', durationSeconds) }, created: true } as never;
    },
  };
  const music: MusicToolConfig = {
    usableModels: ['test-music'],
    createJob: async input => {
      const { durationSeconds } = input.request as { durationSeconds: number };
      return { ok: true, job: { id: startJob('music', durationSeconds) }, created: true } as never;
    },
  };

  const adapter: ProductionAudioAdapter = {
    speech: async () => {
      counts.speech += 1;
      return { ok: true, fileId: makeFile('audio'), durationMs: 1500 };
    },
    soundEffect: async () => {
      counts.sfx += 1;
      return { ok: true, fileId: makeFile('audio'), durationMs: 800 };
    },
  };
  vi.mocked(createProductionAudio).mockReturnValue(adapter);

  const config: ProductionToolConfig = {
    compositions: {
      get: async id => {
        if (id !== COMPOSITION_ID) throw new NotFoundError('Composition not found');
        return structuredClone(stored);
      },
      update: async (id, input: StudioCompositionUpdateInput) => {
        if (id !== COMPOSITION_ID) throw new NotFoundError('Composition not found');
        const next: ProductionComposition = {
          ...stored,
          ...(input.shots && { shots: input.shots }),
          ...(input.timeline && { timeline: input.timeline }),
          ...(input.brief && { brief: input.brief }),
          ...(input.brandKit && { brandKit: input.brandKit }),
        };
        const issues = validateStudioComposition(next, { knownFileIds });
        if (issues.length > 0) throw new UnprocessableEntityError('Invalid composition', { issues });
        stored = structuredClone(next);
        return structuredClone(stored);
      },
    },
    image,
    imageModels: [referenceModel],
    video,
    music,
    // The adapter itself is mocked (createProductionAudio); the jobs only satisfy the config guard.
    audio: {
      jobs: {
        createSpeechJob: vi.fn(),
        createSoundEffectJob: vi.fn(),
        runInline: vi.fn(),
        readOutput: vi.fn(),
        cancel: vi.fn(),
      },
    },
    findJobs: async ids => ids.flatMap(id => (jobs.has(id) ? [jobs.get(id) as ProductionJobView] : [])),
    referenceImages: async ids =>
      new Map(ids.flatMap(id => (kinds.get(id) === 'image' ? [[id, 'ready'] as const] : []))),
    waitTimeoutMs: 100,
    pollIntervalMs: 1,
  };

  const statusUpdate = vi.fn(async () => undefined);
  const context = {
    userId: 'user-1',
    questId: 'quest-1',
    sessionId: 'session-1',
    user: { isAdmin: false },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    statusUpdate,
  } as unknown as ToolContext;

  return {
    config,
    context,
    statusUpdate,
    composition: () => stored,
    counts,
    imageRequests,
    addFile: makeFile,
    imageState,
    finishRunningImages,
  };
}

type Tool = typeof productionStoryboardTool;
const run = async (tool: Tool, harness: Harness, args: Record<string, unknown>): Promise<string> => {
  const { toolFn } = tool.implementation(harness.context, harness.config);
  return toolFn(args);
};

const STORYBOARD = {
  compositionId: COMPOSITION_ID,
  productFileId: PRODUCT_FILE_ID,
  brief: 'A spring sale',
  shots: [
    { title: 'Hook', prompt: 'A bottle on a sunny table', durationSeconds: 3, voiceLine: 'Spring is here.' },
    { title: 'Product', prompt: 'Close-up of the bottle label', durationSeconds: 4, voiceLine: 'Meet the bottle.' },
    { title: 'CTA', prompt: 'The bottle with a price tag', durationSeconds: 5, voiceLine: 'Shop now.' },
  ],
};

describe('production director tools', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = createHarness();
  });

  it('storyboards, shoots, scores and assembles a production that passes the composition validator', async () => {
    const storyboard = JSON.parse(await run(productionStoryboardTool, harness, STORYBOARD));
    expect(storyboard.totalSeconds).toBe(12);
    expect(harness.composition().brandKit.productFileIds).toEqual([PRODUCT_FILE_ID]);
    expect(harness.composition().brief.summary).toBe('A spring sale');
    expect(harness.composition().shots.map(shot => shot.id)).toEqual(['shot-1', 'shot-2', 'shot-3']);

    const generated = JSON.parse(await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID }));
    expect(generated.shots).toHaveLength(3);
    expect(generated.next).toContain('production_add_audio');
    for (const shot of harness.composition().shots) {
      expect(shot.chosenFileId).toBeDefined();
      expect(shot.clipFileId).toBeDefined();
      expect(shot.fileIds).toEqual(expect.arrayContaining([shot.chosenFileId, shot.clipFileId]));
    }

    const audio = JSON.parse(
      await run(productionAddAudioTool, harness, {
        compositionId: COMPOSITION_ID,
        music: { prompt: 'Warm acoustic, upbeat' },
        voiceover: true,
        soundEffects: [{ shotId: 'shot-2', prompt: 'soft whoosh' }],
      })
    );
    expect(audio.added).toEqual({ voice: 3, sfx: 1, music: 1 });

    const assembled = JSON.parse(await run(productionAssembleTool, harness, { compositionId: COMPOSITION_ID }));
    expect(assembled).toMatchObject({
      durationSeconds: 12,
      clips: 3,
      captions: 3,
      audio: { music: 1, voice: 3, sfx: 1 },
    });

    const final = harness.composition();
    expect(
      validateStudioComposition(final, {
        knownFileIds: new Set([PRODUCT_FILE_ID, ...studioCompositionFileIds(final)]),
      })
    ).toEqual([]);
    expect(final.timeline.durationMs).toBe(3000 + 4000 + 5000);

    const video = directorClips(final.timeline, 'video');
    expect(video.map(clip => clip.id)).toEqual(['shot-1-video', 'shot-2-video', 'shot-3-video']);
    expect(video.map(clip => clip.startMs)).toEqual([0, 3000, 7000]);
    expect(video.map(clip => (clip as { fileId: string }).fileId)).toEqual(final.shots.map(shot => shot.clipFileId));
    expect(directorClips(final.timeline, 'captions')).toHaveLength(3);
    expect(directorClips(final.timeline, 'music')).toHaveLength(1);
    expect(directorClips(final.timeline, 'voice')).toHaveLength(3);
    expect(directorClips(final.timeline, 'sfx')).toHaveLength(1);
    // The blank template's own empty video lane stays; the director never removes a lane it did not make.
    expect(final.timeline.tracks.map(track => track.id)).toEqual([
      DIRECTOR_TRACK_IDS.video,
      'track-video-1',
      DIRECTOR_TRACK_IDS.music,
      DIRECTOR_TRACK_IDS.voice,
      DIRECTOR_TRACK_IDS.sfx,
      DIRECTOR_TRACK_IDS.captions,
    ]);
  });

  it('clears the old voice when the storyboard is replaced but keeps the picture until assemble', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });
    await run(productionAddAudioTool, harness, { compositionId: COMPOSITION_ID, voiceover: true });
    await run(productionAssembleTool, harness, { compositionId: COMPOSITION_ID });
    expect(directorClips(harness.composition().timeline, 'voice')).toHaveLength(3);

    await run(productionStoryboardTool, harness, { ...STORYBOARD, replace: true });
    const timeline = harness.composition().timeline;
    for (const kind of ['voice', 'sfx'] as const) {
      expect(directorClips(timeline, kind)).toEqual([]);
    }
    // A run that stops before production_assemble still leaves a cut that plays.
    expect(directorClips(timeline, 'video')).toHaveLength(3);
    expect(directorClips(timeline, 'captions')).toHaveLength(3);
  });

  it('logs an unexpected failure and reports it to the director instead of ending the run', () => {
    const error = new Error('socket hang up');
    expect(describeProductionError(error, harness.context.logger, 'production_assemble')).toMatch(
      /^Error: this step failed unexpectedly \(socket hang up\)/
    );
    expect(harness.context.logger.error).toHaveBeenCalledWith('[production_assemble] unexpected failure', error);
  });

  it('rethrows a terminal error and does not log a refusal the model can act on', () => {
    const denied = insufficientCreditsError('out of credits');
    expect(() => describeProductionError(denied, harness.context.logger, 'production_assemble')).toThrow(denied);
    expect(describeProductionError(new ProductionToolError('no shots'), harness.context.logger, 'x')).toBe(
      'Error: no shots'
    );
    expect(harness.context.logger.error).not.toHaveBeenCalled();
  });

  it('keeps a voice line typed with a curly apostrophe when the storyboard is re-sent with a straight one', async () => {
    const [first, ...rest] = STORYBOARD.shots;
    await run(productionStoryboardTool, harness, {
      ...STORYBOARD,
      shots: [{ ...first, voiceLine: 'Don\u2019t stop now.' }, ...rest],
    });
    const result = await run(productionStoryboardTool, harness, {
      compositionId: COMPOSITION_ID,
      shots: [{ keep: 'shot-1', voiceLine: "Don't stop now." }, { keep: 'shot-2' }, { keep: 'shot-3' }],
    });
    expect(result).not.toMatch(/^Error/);
  });

  it('feeds the product photo to every image job as a reference input and posts job cards', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });

    expect(harness.imageRequests).toHaveLength(3);
    for (const { request } of harness.imageRequests) {
      expect(request).toMatchObject({
        model: referenceModel,
        mode: 'generate',
        inputs: [{ role: 'reference', fileId: PRODUCT_FILE_ID }],
      });
    }
    const cards = harness.statusUpdate.mock.calls.flatMap(
      ([update]) => (update as { generationJobs: { kind: string }[] }).generationJobs
    );
    expect(cards.filter(card => card.kind === 'image')).toHaveLength(3);
    expect(cards.filter(card => card.kind === 'video')).toHaveLength(3);
  });

  describe('shot references', () => {
    const inputsOf = (request: unknown) => (request as { inputs?: { fileId: string }[] }).inputs?.map(i => i.fileId);
    const setUp = async (model: ImageModels) => {
      harness.config.imageModels = [model];
      await run(productionStoryboardTool, harness, { ...STORYBOARD, productFileId: undefined });
      const photo = harness.addFile('image');
      const kitVideo = harness.addFile('video');
      const kitImage = harness.addFile('image');
      const current = harness.composition();
      await harness.config.compositions.update(COMPOSITION_ID, {
        brief: { ...current.brief, productFileId: photo },
        brandKit: { ...current.brandKit, productFileIds: [kitVideo, kitImage, photo] },
      });
      return { photo, kitVideo, kitImage };
    };

    it('puts the brief photo first, then the kit images, and never a kit video', async () => {
      const { photo, kitImage } = await setUp(multiReferenceModel);
      await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });

      expect(harness.imageRequests).toHaveLength(3);
      for (const { request } of harness.imageRequests) expect(inputsOf(request)).toEqual([photo, kitImage]);
    });

    it('drops the video before slicing to a one-reference model, so the brief photo takes the slot', async () => {
      const { photo } = await setUp(singleReferenceModel);
      await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });

      for (const { request } of harness.imageRequests) expect(inputsOf(request)).toEqual([photo]);
    });

    it('uses a kit image when a video sits at the front of the kit and there is no brief photo', async () => {
      harness.config.imageModels = [singleReferenceModel];
      await run(productionStoryboardTool, harness, { ...STORYBOARD, productFileId: undefined });
      const kitVideo = harness.addFile('video');
      const kitImage = harness.addFile('image');
      await harness.config.compositions.update(COMPOSITION_ID, {
        brandKit: { ...harness.composition().brandKit, productFileIds: [kitVideo, kitImage] },
      });
      await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });

      for (const { request } of harness.imageRequests) expect(inputsOf(request)).toEqual([kitImage]);
    });

    it("keeps the user's look first when the storyboard adds a product photo, so a one-reference take uses it", async () => {
      harness.config.imageModels = [singleReferenceModel];
      await run(productionStoryboardTool, harness, { ...STORYBOARD, productFileId: undefined });
      const look = harness.addFile('image');
      await harness.config.compositions.update(COMPOSITION_ID, {
        brandKit: { ...harness.composition().brandKit, productFileIds: [look] },
      });
      await run(productionStoryboardTool, harness, STORYBOARD);
      expect(harness.composition().brandKit.productFileIds).toEqual([look, PRODUCT_FILE_ID]);

      await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
      for (const { request } of harness.imageRequests) expect(inputsOf(request)).toEqual([look]);
    });
  });

  describe('saved characters', () => {
    const inputsOf = (request: unknown) => (request as { inputs?: { fileId: string }[] }).inputs?.map(i => i.fileId);
    const promptOf = (request: unknown) => (request as { prompt: string }).prompt;
    const setUp = async (model: ImageModels) => {
      harness.config.imageModels = [model];
      const maya = { id: 'maya', name: 'Maya', fileId: harness.addFile('image') };
      const fox = { id: 'fox', name: 'Fox', fileId: harness.addFile('image') };
      await run(productionStoryboardTool, harness, STORYBOARD);
      await harness.config.compositions.update(COMPOSITION_ID, {
        brandKit: { ...harness.composition().brandKit, characters: [maya, fox] },
      });
      const [hook, product, cta] = STORYBOARD.shots;
      const result = await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ ...hook, characters: ['fox', 'MAYA'] }, product, { ...cta, characters: ['Maya'] }],
      });
      return { maya, fox, result };
    };

    it('maps the named characters to kit ids per shot, in the order given', async () => {
      const { result } = await setUp(multiReferenceModel);
      expect(result).not.toMatch(/^Error/);
      expect(harness.composition().shots.map(shot => shot.characterIds)).toEqual([
        ['fox', 'maya'],
        undefined,
        ['maya'],
      ]);
    });

    it('refuses a character the kit does not have', async () => {
      await setUp(multiReferenceModel);
      const result = await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: 'shot-1', characters: ['Bob'] }, { keep: 'shot-2' }, { keep: 'shot-3' }],
      });
      expect(result).toMatch(/"Bob" is not a saved character/);
    });

    it('refuses a name that matches several characters, but an exact id wins', async () => {
      await setUp(multiReferenceModel);
      const kit = harness.composition().brandKit;
      const fileId = kit.characters[0].fileId;
      await harness.config.compositions.update(COMPOSITION_ID, {
        brandKit: {
          ...kit,
          characters: [...kit.characters, { id: 'z1', name: 'Zed', fileId }, { id: 'z2', name: 'zed', fileId }],
        },
      });
      const keep = [{ keep: 'shot-2' }, { keep: 'shot-3' }];
      const ambiguous = await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: 'shot-1', characters: ['ZED'] }, ...keep],
      });
      expect(ambiguous).toMatch(/"ZED" is ambiguous.*z1, z2/);
      const byId = await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: 'shot-1', characters: ['z2'] }, ...keep],
      });
      expect(byId).not.toMatch(/^Error/);
      expect(harness.composition().shots[0].characterIds).toEqual(['z2']);
    });

    it("references the product, then the shot's characters, and names them in the prompt", async () => {
      const cap = referenceCap(multiReferenceModel);
      const { maya, fox } = await setUp(multiReferenceModel);
      await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });

      const [hook, product, cta] = harness.imageRequests.map(({ request }) => request);
      expect(inputsOf(hook)).toEqual([PRODUCT_FILE_ID, fox.fileId, maya.fileId].slice(0, cap));
      expect(promptOf(hook)).toMatch(/^Feature Fox/);
      expect(inputsOf(product)).toEqual([PRODUCT_FILE_ID]);
      expect(promptOf(product)).not.toMatch(/Feature Maya|Feature Fox/);
      expect(inputsOf(cta)).toEqual([PRODUCT_FILE_ID, maya.fileId]);
    });

    it('keeps the product on a one-reference model and reports the characters it dropped', async () => {
      await setUp(singleReferenceModel);
      const result = JSON.parse(
        await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false })
      ) as { shots: { id: string; charactersDropped?: { names: string[] } }[]; charactersNote?: string };

      for (const { request } of harness.imageRequests) expect(inputsOf(request)).toEqual([PRODUCT_FILE_ID]);
      expect(result.shots.map(shot => shot.charactersDropped?.names)).toEqual([['Fox', 'Maya'], undefined, ['Maya']]);
      expect(result.charactersNote).toMatch(/Tell the user/);
    });

    it('reports a featured character whose file cannot be a reference and leaves it out of the job', async () => {
      const { maya } = await setUp(multiReferenceModel);
      const unusable = harness.addFile('video');
      await harness.config.compositions.update(COMPOSITION_ID, {
        brandKit: {
          ...harness.composition().brandKit,
          characters: [
            { id: 'maya', name: 'Maya', fileId: maya.fileId },
            { id: 'fox', name: 'Fox', fileId: unusable },
          ],
        },
      });
      const result = JSON.parse(
        await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false })
      ) as { shots: { charactersDropped?: { names: string[] } }[]; charactersNote?: string };

      expect(result.shots.map(shot => shot.charactersDropped?.names)).toEqual([['Fox'], undefined, undefined]);
      expect(result.charactersNote).toMatch(/charactersDropped/);
      const [hook] = harness.imageRequests.map(({ request }) => request);
      expect(inputsOf(hook)).toEqual([PRODUCT_FILE_ID, maya.fileId]);
    });
  });

  describe('product look', () => {
    const inputsOf = (request: unknown) => (request as { inputs?: { fileId: string }[] }).inputs?.map(i => i.fileId);
    const isLook = (request: unknown) => (request as { prompt: string }).prompt.startsWith('Product packshot');
    const noProduct = { ...STORYBOARD, productFileId: undefined };

    it('makes one look from the brief, saves it first in the brand kit, and references it on every take', async () => {
      await run(productionStoryboardTool, harness, noProduct);
      const first = JSON.parse(
        await run(productionGenerateShotTool, harness, {
          compositionId: COMPOSITION_ID,
          shotIds: ['shot-1'],
          animate: false,
        })
      );
      expect(first.productLook).toBe('made');
      const [look] = harness.composition().brandKit.productFileIds;
      expect(look).toBeDefined();

      const second = JSON.parse(
        await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false })
      );
      expect(second.productLook).toBeUndefined();
      const requests = harness.imageRequests.map(({ request }) => request);
      expect(requests.filter(isLook)).toHaveLength(1);
      expect(inputsOf(requests.find(isLook))).toBeUndefined();
      const takes = requests.filter(request => !isLook(request));
      expect(takes).toHaveLength(3);
      for (const take of takes) expect(inputsOf(take)).toEqual([look]);
      expect(harness.composition().brandKit.productFileIds).toEqual([look]);
    });

    it('does not bring back a look the user removed when a re-call replays its finished job', async () => {
      await run(productionStoryboardTool, harness, noProduct);
      await run(productionGenerateShotTool, harness, {
        compositionId: COMPOSITION_ID,
        shotIds: ['shot-1'],
        animate: false,
      });
      const [look] = harness.composition().brandKit.productFileIds;
      await harness.config.compositions.update(COMPOSITION_ID, {
        brandKit: { ...harness.composition().brandKit, productFileIds: [] },
      });
      const second = JSON.parse(
        await run(productionGenerateShotTool, harness, {
          compositionId: COMPOSITION_ID,
          shotIds: ['shot-2'],
          animate: false,
        })
      );
      expect(second.productLook).toMatch(/^skipped: /);
      expect(harness.composition().brandKit.productFileIds).not.toContain(look);
      expect(harness.imageRequests.filter(({ request }) => isLook(request))).toHaveLength(1);
    });

    it('saves a look that finished after the call stopped waiting, and references it on the re-call', async () => {
      harness.imageState.next = request => (isLook(request) ? 'running' : 'succeeded');
      await run(productionStoryboardTool, harness, noProduct);
      const first = JSON.parse(
        await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false })
      );
      expect(first.productLook).toBe('pending');
      harness.finishRunningImages();

      const second = JSON.parse(
        await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false })
      );
      expect(second.productLook).toBe('made');
      const [look] = harness.composition().brandKit.productFileIds;
      expect(look).toBeDefined();
      const requests = harness.imageRequests.map(({ request }) => request);
      expect(requests.filter(isLook)).toHaveLength(1);
      const takes = requests.filter(request => !isLook(request));
      expect(takes).toHaveLength(3);
      for (const take of takes) expect(inputsOf(take)).toEqual([look]);
    });

    it('starts no takes while the look is still running, and reports every shot pending on it', async () => {
      harness.imageState.next = request => (isLook(request) ? 'running' : 'succeeded');
      await run(productionStoryboardTool, harness, noProduct);
      const result = JSON.parse(await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID }));

      expect(result.productLook).toBe('pending');
      expect(harness.counts.image).toBe(1);
      expect(harness.counts.video).toBe(0);
      for (const shot of result.shots) expect(shot.pending).toEqual([expect.stringContaining('product look')]);
      expect(result.next).toContain('call production_generate_shot again');
      expect(harness.composition().brandKit.productFileIds).toEqual([]);
    });

    it('starts the takes without a reference when the look fails', async () => {
      harness.imageState.next = request => (isLook(request) ? 'failed' : 'succeeded');
      await run(productionStoryboardTool, harness, noProduct);
      const result = JSON.parse(
        await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false })
      );

      expect(result.productLook).toMatch(/^failed: /);
      const takes = harness.imageRequests.filter(({ request }) => !isLook(request));
      expect(takes).toHaveLength(3);
      for (const { request } of takes) expect(inputsOf(request)).toBeUndefined();
      expect(harness.composition().shots.every(shot => shot.chosenFileId)).toBe(true);
    });

    it('neither saves nor references a look the image job would refuse', async () => {
      harness.config.referenceImages = async () => new Map();
      await run(productionStoryboardTool, harness, noProduct);
      const result = JSON.parse(
        await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false })
      );

      expect(result.productLook).toMatch(/^failed: /);
      expect(harness.composition().brandKit.productFileIds).toEqual([]);
      const takes = harness.imageRequests.filter(({ request }) => !isLook(request));
      expect(takes).toHaveLength(3);
      for (const { request } of takes) expect(inputsOf(request)).toBeUndefined();
      for (const shot of result.shots) expect(shot.pending ?? []).toEqual([]);
    });

    it('reports a saved look that was refused later as failed, not as removed from the brand kit', async () => {
      await run(productionStoryboardTool, harness, noProduct);
      await run(productionGenerateShotTool, harness, {
        compositionId: COMPOSITION_ID,
        shotIds: ['shot-1'],
        animate: false,
      });
      expect(harness.composition().brandKit.productFileIds).toHaveLength(1);
      harness.config.referenceImages = async () => new Map();
      const second = JSON.parse(
        await run(productionGenerateShotTool, harness, {
          compositionId: COMPOSITION_ID,
          shotIds: ['shot-2'],
          animate: false,
        })
      );
      expect(second.productLook).toMatch(/^failed: /);
    });

    it('skips the look when the brief has no summary', async () => {
      await run(productionStoryboardTool, harness, noProduct);
      await harness.config.compositions.update(COMPOSITION_ID, { brief: {} });
      const result = JSON.parse(
        await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false })
      );

      expect(result.productLook).toMatch(/^skipped: /);
      expect(harness.imageRequests.filter(({ request }) => isLook(request))).toHaveLength(0);
      expect(harness.counts.image).toBe(3);
    });

    it('makes no look when the production has a product image', async () => {
      await run(productionStoryboardTool, harness, STORYBOARD);
      const result = JSON.parse(await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID }));
      expect(result.productLook).toBeUndefined();
      expect(harness.imageRequests.filter(({ request }) => isLook(request))).toHaveLength(0);
    });
  });

  it('starts nothing new when generate_shot is called again with the same arguments', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });
    const before = { ...harness.counts };

    const again = JSON.parse(await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID }));

    expect(harness.counts).toEqual(before);
    expect(again.next).toContain('production_add_audio');
  });

  it('reports a clip whose take is still in its safety check as pending, then animates it on the next call', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    const createJob = harness.config.video!.createJob;
    harness.config.video!.createJob = async () =>
      ({ ok: false, code: 'input_image_not_found', message: 'Input image not found (first_frame)' }) as never;
    harness.config.inputReadyTimeoutMs = 0;

    const first = JSON.parse(await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID }));
    expect(first.next).toContain('call production_generate_shot again');
    expect(first.shots.every((shot: { problem?: string; pending?: string[] }) => !shot.problem && shot.pending)).toBe(
      true
    );

    harness.config.video!.createJob = createJob;
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });
    expect(harness.composition().shots.every(shot => shot.clipFileId)).toBe(true);
  });

  it('refuses to change a shot that has takes unless replace is true', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    const takenShots = harness.composition().shots;
    const reprompted = {
      ...STORYBOARD,
      shots: STORYBOARD.shots.map((shot, index) => (index === 1 ? { ...shot, prompt: 'The bottle on a beach' } : shot)),
    };

    const refused = await run(productionStoryboardTool, harness, reprompted);
    expect(refused).toMatch(/^Error: this storyboard changes or removes the prompts of shot-2,.*replace: true/);
    expect(harness.composition().shots).toEqual(takenShots);

    const replaced = JSON.parse(await run(productionStoryboardTool, harness, { ...reprompted, replace: true }));
    expect(replaced.shots).toHaveLength(3);
    expect(replaced.takesDropped).toEqual(['shot-2']);
    expect(harness.composition().shots.map(shot => shot.fileIds.length > 0)).toEqual([true, false, true]);
  });

  it('carries a shot over by id with keep, without its prompt, and refuses a stand-in prompt', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });
    const before = harness.composition().shots;

    const placeholder = {
      compositionId: COMPOSITION_ID,
      shots: [{ title: 'Hook', prompt: 'KEEP_EXISTING_SHOT_1', durationSeconds: 3 }],
      replace: true,
    };
    expect(await run(productionStoryboardTool, harness, placeholder)).toMatch(
      /^Error: "KEEP_EXISTING_SHOT_1" is not an image prompt/
    );
    expect(
      await run(productionStoryboardTool, harness, { compositionId: COMPOSITION_ID, shots: [{ keep: 'shot-9' }] })
    ).toMatch(
      /^Error: there is no current shot with id shot-9 to keep \(keep takes an id, not a title\); the current shots are shot-1, shot-2, shot-3/
    );
    expect(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: 'Editor Packshot' }],
      })
    ).toMatch(/^Error: there is no current shot with id Editor Packshot to keep .*shot-1, shot-2, shot-3/);
    expect(harness.composition().shots).toEqual(before);

    const reworded = {
      compositionId: COMPOSITION_ID,
      shots: [
        { keep: 'shot-1' },
        { keep: 'shot-2', voiceLine: 'Meet it.' },
        { keep: 'shot-3', voiceLine: 'Shop the' },
        { title: 'CTA end', prompt: 'The bottle beside a shop sign', durationSeconds: 2, voiceLine: 'spring sale.' },
      ],
    };
    expect(await run(productionStoryboardTool, harness, reworded)).toMatch(
      /^Error: this storyboard no longer says these current voice lines word for word: "Meet the bottle.", "Shop now."/
    );
    expect(harness.composition().shots).toEqual(before);
    const result = JSON.parse(await run(productionStoryboardTool, harness, { ...reworded, rewriteLines: true }));
    expect(result.shots.map((shot: { takesKept?: boolean }) => shot.takesKept ?? false)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(result.takesDropped).toBeUndefined();
    expect(result.linesChanged).toEqual([
      { shot: 'shot-2', was: 'Meet the bottle.', now: 'Meet it.' },
      { shot: 'shot-3', was: 'Shop now.', now: 'Shop the' },
    ]);
    expect(result.linesRemoved).toEqual(['Meet the bottle.', 'Shop now.']);
    expect(result.next).toContain('linesChanged');
    expect(result.next).toContain('linesRemoved');
    const after = harness.composition().shots;
    expect(after.slice(0, 3).map(shot => [shot.prompt, shot.clipFileId, shot.durationMs])).toEqual(
      before.map(shot => [shot.prompt, shot.clipFileId, shot.durationMs])
    );
    expect(after.map(shot => shot.voiceLine)).toEqual(['Spring is here.', 'Meet it.', 'Shop the', 'spring sale.']);
  });

  it('keeps an editor-made shot by id when it has no prompt and no length, with its take', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    const take = harness.composition().shots[0].fileIds[0];
    const editorId = 'shot-3f2b9c1e-7a4d-4e8b-9c55-0d1e2f3a4b5c';
    await harness.config.compositions.update(COMPOSITION_ID, {
      shots: [{ id: editorId, title: 'Added in the editor', fileIds: [take], chosenFileId: take }],
    });

    const result = JSON.parse(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: editorId }, { title: 'CTA', prompt: 'The bottle beside a shop sign', durationSeconds: 2 }],
      })
    );
    expect(result.takesDropped).toBeUndefined();
    expect(result.shots[0]).toMatchObject({ id: 'shot-1', was: editorId, durationMs: 4000, takesKept: true });
    expect(result.shots[1].was).toBeUndefined();
    const [first] = harness.composition().shots;
    expect(first.fileIds).toEqual([take]);
    expect(first.prompt).toBeUndefined();
  });

  it('keeps a prompt-less editor shot as a still unless it is named in shotIds', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    const take = harness.composition().shots[0].fileIds[0];
    const editorId = 'shot-3f2b9c1e-7a4d-4e8b-9c55-0d1e2f3a4b5c';
    await harness.config.compositions.update(COMPOSITION_ID, {
      shots: [{ id: editorId, title: 'Added in the editor', fileIds: [take], chosenFileId: take }],
    });

    const kept = JSON.parse(await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID }));
    expect(harness.counts.video).toBe(0);
    expect(kept.shots[0]).toMatchObject({ id: editorId, problem: expect.stringContaining('kept as a still') });
    expect(harness.composition().shots[0].clipFileId).toBeUndefined();

    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, shotIds: [editorId] });
    expect(harness.counts.video).toBe(1);
    expect(harness.composition().shots[0].clipFileId).toBeDefined();
  });

  it('gives each of two same-prompt shots its own takes when they swap places', async () => {
    await run(productionStoryboardTool, harness, {
      compositionId: COMPOSITION_ID,
      shots: [
        { title: 'A', prompt: 'A bottle on a sunny table', durationSeconds: 3 },
        { title: 'B', prompt: 'A bottle on a sunny table', durationSeconds: 3 },
      ],
    });
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    const [one, two] = harness.composition().shots;
    expect(one.fileIds[0]).not.toEqual(two.fileIds[0]);

    const result = JSON.parse(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: two.id }, { keep: one.id }],
      })
    );
    expect(result.takesDropped).toBeUndefined();
    expect(harness.composition().shots.map(shot => shot.fileIds)).toEqual([two.fileIds, one.fileIds]);
  });

  it('refuses a shot that has both keep and a prompt, and a shot kept twice', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    const before = harness.composition().shots;

    expect(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: 'shot-1', prompt: 'A bottle on a beach at dusk' }],
      })
    ).toMatch(/^Error: shot-1 has keep and a prompt;/);
    expect(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: 'shot-1' }, { keep: 'shot-1' }],
      })
    ).toMatch(/^Error: shot-1 is kept twice; keep each shot once\./);
    expect(harness.composition().shots).toEqual(before);
  });

  it('keeps the takes and clips of shots that move when a shot is inserted before them', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });
    const before = harness.composition().shots;
    const inserted = {
      ...STORYBOARD,
      shots: [
        { title: 'Teaser', prompt: 'A shadow on the wall', durationSeconds: 2 },
        ...STORYBOARD.shots.map(shot => ({ ...shot, prompt: `  ${shot.prompt.toUpperCase()} ` })),
      ],
    };

    const result = JSON.parse(await run(productionStoryboardTool, harness, inserted));
    expect(result.shots.map((shot: { takesKept?: boolean }) => shot.takesKept ?? false)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    const after = harness.composition().shots;
    expect(after.slice(1).map(shot => shot.clipFileId)).toEqual(before.map(shot => shot.clipFileId));
  });

  it('keeps takes and clips on a re-time, and refuses to grow a shot past its clip even with replace', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });
    const before = harness.composition().shots;
    expect(before.every(shot => shot.clipFileId)).toBe(true);
    const retimed = {
      ...STORYBOARD,
      shots: STORYBOARD.shots.map((shot, index) =>
        index === 0 ? { ...shot, durationSeconds: 20 } : { ...shot, voiceLine: `Shorter ${index}.` }
      ),
      rewriteLines: true,
    };

    const refused = await run(productionStoryboardTool, harness, retimed);
    expect(refused).toMatch(/^Error: shot-1 would run longer than its clip/);
    expect(harness.composition().shots).toEqual(before);

    expect(await run(productionStoryboardTool, harness, { ...retimed, replace: true })).toMatch(
      /^Error: shot-1 would run longer than its clip/
    );
    expect(harness.composition().shots).toEqual(before);

    const kept = { ...retimed, shots: retimed.shots.map((shot, index) => (index === 0 ? STORYBOARD.shots[0]! : shot)) };
    await run(productionStoryboardTool, harness, kept);
    const after = harness.composition().shots;
    expect(after.map(shot => shot.chosenFileId)).toEqual(before.map(shot => shot.chosenFileId));
    expect(after.map(shot => shot.clipFileId)).toEqual(before.map(shot => shot.clipFileId));
    expect(after.slice(1).map(shot => shot.voiceLine)).toEqual(['Shorter 1.', 'Shorter 2.']);
  });

  it('keeps the music bed, trimmed, when a re-time shortens the cut', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    await run(productionAddAudioTool, harness, { compositionId: COMPOSITION_ID, music: { prompt: 'bright acoustic' } });
    expect(harness.counts.music).toBe(1);
    const shorter = { ...STORYBOARD, shots: STORYBOARD.shots.map(shot => ({ ...shot, durationSeconds: 2 })) };

    await run(productionStoryboardTool, harness, shorter);
    const music = harness.composition().timeline.tracks.find(track => track.kind === 'music');
    expect(music?.clips).toHaveLength(1);
    expect(music?.clips[0]).toMatchObject({ startMs: 0, durationMs: 6000 });

    await run(productionAddAudioTool, harness, { compositionId: COMPOSITION_ID, music: { prompt: 'bright acoustic' } });
    expect(harness.counts.music).toBe(1);
  });

  it('reports a music bed that ends before the cut when it assembles', async () => {
    const shorter = { ...STORYBOARD, shots: STORYBOARD.shots.map(shot => ({ ...shot, durationSeconds: 2 })) };
    await run(productionStoryboardTool, harness, shorter);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    await run(productionAddAudioTool, harness, { compositionId: COMPOSITION_ID, music: { prompt: 'bright acoustic' } });
    await run(productionStoryboardTool, harness, STORYBOARD);

    const assembled = JSON.parse(await run(productionAssembleTool, harness, { compositionId: COMPOSITION_ID }));
    expect(assembled.musicEndsBeforeCutMs).toBe(6000);
    expect(assembled.next).toContain('a music bed that ends before the cut');
  });

  it('remakes the music bed when a re-time grows the cut past it', async () => {
    const shorter = { ...STORYBOARD, shots: STORYBOARD.shots.map(shot => ({ ...shot, durationSeconds: 2 })) };
    await run(productionStoryboardTool, harness, shorter);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    await run(productionAddAudioTool, harness, { compositionId: COMPOSITION_ID, music: { prompt: 'bright acoustic' } });
    expect(harness.counts.music).toBe(1);

    await run(productionStoryboardTool, harness, STORYBOARD);
    const audio = JSON.parse(
      await run(productionAddAudioTool, harness, {
        compositionId: COMPOSITION_ID,
        music: { prompt: 'bright acoustic' },
      })
    );
    expect(harness.counts.music).toBe(2);
    expect(audio.notes).toContain('the music bed ended 6000 ms before the cut, so a new one was made.');
    const music = directorClips(harness.composition().timeline, 'music');
    expect(music).toHaveLength(1);
    expect(music[0]!.startMs + music[0]!.durationMs).toBeGreaterThanOrEqual(12_000 - 500);
  });

  it('does not remake the music bed when the model cannot cover the grown cut', async () => {
    const withSeconds = (seconds: number) => ({
      ...STORYBOARD,
      shots: STORYBOARD.shots.map(shot => ({ ...shot, durationSeconds: seconds })),
    });
    await run(productionStoryboardTool, harness, withSeconds(2));
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    await run(productionAddAudioTool, harness, { compositionId: COMPOSITION_ID, music: { prompt: 'bright acoustic' } });
    expect(harness.counts.music).toBe(1);

    await run(productionStoryboardTool, harness, withSeconds(15));
    const music = { compositionId: COMPOSITION_ID, music: { prompt: 'bright acoustic' } };
    await run(productionAddAudioTool, harness, music);
    expect(harness.counts.music).toBe(2);
    await run(productionAddAudioTool, harness, music);
    expect(harness.counts.music).toBe(2);
  });

  it('refuses a re-time that leaves a shot too short for its voice line', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    await run(productionAddAudioTool, harness, { compositionId: COMPOSITION_ID, voiceover: true });
    const squeezed = {
      ...STORYBOARD,
      shots: STORYBOARD.shots.map((shot, index) => (index === 0 ? { ...shot, durationSeconds: 1 } : shot)),
    };

    const refused = await run(productionStoryboardTool, harness, squeezed);
    expect(refused).toMatch(/^Error: shot-1's voice line runs 1500 ms but would have 1000 ms/);

    const rewritten = {
      ...squeezed,
      shots: squeezed.shots.map((shot, index) => (index === 0 ? { ...shot, voiceLine: 'Hi.' } : shot)),
      rewriteLines: true,
    };
    expect(await run(productionStoryboardTool, harness, rewritten)).not.toMatch(/^Error/);
  });

  it('lets a line be split over shots word for word without rewriteLines', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    const split = JSON.parse(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [
          { keep: 'shot-1', voiceLine: 'Spring is' },
          { keep: 'shot-2', voiceLine: 'here! Meet the bottle.' },
          { keep: 'shot-3' },
        ],
      })
    );
    expect(split.linesRemoved).toBeUndefined();
    expect(split.linesChanged).toHaveLength(2);
  });

  it('refuses the same voice line on two shots', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    const before = harness.composition().shots;
    expect(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [
          { keep: 'shot-1' },
          { keep: 'shot-2' },
          { keep: 'shot-3' },
          { title: 'End', prompt: 'The bottle on a shelf', durationSeconds: 2, voiceLine: 'Shop now!' },
        ],
      })
    ).toMatch(/^Error: "Shop now!" is the voice line of more than one shot/);
    expect(harness.composition().shots).toEqual(before);
  });

  it('keeps a voice line the user already repeated when a call leaves it alone', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    harness.composition().shots[2].voiceLine = 'Spring is here.';
    const result = await run(productionStoryboardTool, harness, {
      compositionId: COMPOSITION_ID,
      shots: [{ keep: 'shot-1' }, { keep: 'shot-2', title: 'Product shot' }, { keep: 'shot-3' }],
    });
    expect(result).not.toMatch(/^Error/);
    expect(harness.composition().shots.map(shot => shot.voiceLine)).toEqual([
      'Spring is here.',
      'Meet the bottle.',
      'Spring is here.',
    ]);
  });

  it('refuses a new shot that repeats a line a kept shot already says', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    harness.composition().shots[2].voiceLine = 'Spring is here.';
    expect(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [
          { keep: 'shot-1' },
          { keep: 'shot-2' },
          { keep: 'shot-3' },
          { title: 'End', prompt: 'The bottle on a shelf', durationSeconds: 2, voiceLine: 'Spring is here.' },
        ],
      })
    ).toMatch(/^Error: "Spring is here." is the voice line of more than one shot/);
  });

  it('remembers a reorder across a resume that rebuilds the config for the same run', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    const swap = { compositionId: COMPOSITION_ID, shots: [{ keep: 'shot-1' }, { keep: 'shot-3' }, { keep: 'shot-2' }] };
    const firstLeg = { ...harness, config: { ...harness.config, runId: 'quest-resumed' } };
    const resumedLeg = { ...harness, config: { ...harness.config, runId: 'quest-resumed' } };

    expect(await run(productionStoryboardTool, firstLeg, swap)).not.toMatch(/^Error/);
    expect(await run(productionStoryboardTool, resumedLeg, swap)).toMatch(/^Error: this run already moved the shots/);
  });

  it('refuses a second reorder in one run, so a repeated swap does not undo the first', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    const swap = { compositionId: COMPOSITION_ID, shots: [{ keep: 'shot-1' }, { keep: 'shot-3' }, { keep: 'shot-2' }] };
    const titles = () => harness.composition().shots.map(shot => shot.title);
    const original = titles();

    expect(await run(productionStoryboardTool, harness, swap)).not.toMatch(/^Error/);
    const swapped = titles();
    expect(swapped).toEqual([original[0], original[2], original[1]]);

    expect(await run(productionStoryboardTool, harness, swap)).toMatch(/^Error: this run already moved the shots/);
    expect(titles()).toEqual(swapped);
    const retime = {
      compositionId: COMPOSITION_ID,
      shots: [{ keep: 'shot-1' }, { keep: 'shot-2' }, { keep: 'shot-3' }],
    };
    expect(await run(productionStoryboardTool, harness, retime)).not.toMatch(/^Error/);
  });

  it('reports lines that moved with their pictures, and pins them back on a second call in the same order', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    const lines = () => harness.composition().shots.map(shot => shot.voiceLine);
    const original = lines();

    const swapped = JSON.parse(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: 'shot-1' }, { keep: 'shot-3' }, { keep: 'shot-2' }],
      })
    );
    expect(swapped.linesMoved).toEqual([
      { shot: 'shot-2', says: original[2], before: original[1] },
      { shot: 'shot-3', says: original[1], before: original[2] },
    ]);
    expect(swapped.shots.map((shot: { voiceLine?: string }) => shot.voiceLine)).toEqual(lines());
    expect(swapped.next).toContain('linesMoved');

    const pinned = JSON.parse(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [
          { keep: 'shot-1' },
          { keep: 'shot-2', voiceLine: original[1] },
          { keep: 'shot-3', voiceLine: original[2] },
        ],
      })
    );
    expect(pinned.linesMoved).toBeUndefined();
    expect(lines()).toEqual(original);
  });

  it('does not report moved lines when no shot changes place', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    const result = JSON.parse(
      await run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [{ keep: 'shot-1' }, { keep: 'shot-2' }, { keep: 'shot-3' }],
      })
    );
    expect(result.linesMoved).toBeUndefined();
  });

  it('tells the director to retry with rewriteLines when it rewords a kept shot without it', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    const refused = await run(productionStoryboardTool, harness, {
      compositionId: COMPOSITION_ID,
      shots: [{ keep: 'shot-1' }, { keep: 'shot-2', voiceLine: 'A brand new line.' }, { keep: 'shot-3' }],
    });
    expect(refused).toMatch(/^Error: this storyboard no longer says/);
    expect(refused).toContain('You gave shot-2 a new voice line');
  });

  it('keeps stills on the timeline when animate is false', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
    expect(harness.counts.video).toBe(0);

    const assembled = JSON.parse(await run(productionAssembleTool, harness, { compositionId: COMPOSITION_ID }));
    expect(assembled.stills).toEqual(['shot-1', 'shot-2', 'shot-3']);
  });

  it('keeps each voice line on its shot and reports a line too long for it', async () => {
    const adapter = vi.mocked(createProductionAudio)(harness.config.audio!);
    let calls = 0;
    vi.mocked(createProductionAudio).mockReturnValue({
      ...adapter,
      speech: async request => {
        const result = await adapter.speech(request);
        return result.ok && calls++ === 0 ? { ...result, durationMs: 5000 } : result;
      },
    });
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });

    const result = JSON.parse(
      await run(productionAddAudioTool, harness, { compositionId: COMPOSITION_ID, voiceover: true })
    );
    expect(result.notes.join(' ')).toMatch(/the voice line for shot-1 \(".+"\) runs 5000 ms/);
    expect(result.cutLines).toEqual(['shot-1']);
    expect(result.next).toMatch(/^The voice lines of shot-1 are cut short/);
    const voice = harness.composition().timeline.tracks.find(track => track.kind === 'voice');
    expect(voice?.clips.map(clip => [clip.startMs, clip.durationMs])).toEqual([
      [200, 3000],
      [3200, 1500],
      [7200, 1500],
    ]);
  });

  it('keeps an existing audio part unless it is named in replace', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });
    const args = { compositionId: COMPOSITION_ID, voiceover: true };
    await run(productionAddAudioTool, harness, args);
    expect(harness.counts.speech).toBe(3);

    await run(productionAddAudioTool, harness, args);
    expect(harness.counts.speech).toBe(3);

    await run(productionAddAudioTool, harness, { ...args, replace: ['voiceover'] });
    expect(harness.counts.speech).toBe(6);
  });

  describe('failures come back as an Error string, not a throw', () => {
    const unknownComposition = 'f'.repeat(24);

    it.each([
      ['production_storyboard', productionStoryboardTool, { shots: STORYBOARD.shots }],
      ['production_generate_shot', productionGenerateShotTool, {}],
      ['production_add_audio', productionAddAudioTool, {}],
      ['production_assemble', productionAssembleTool, {}],
    ])('%s for an unknown composition', async (_name, tool, extra) => {
      const result = await run(tool, harness, { compositionId: unknownComposition, ...extra });
      expect(result).toBe(
        'Error: that production was not found. Use the production id from this conversation (the Direct message names it), not a file id.'
      );
    });

    it('assemble before any take exists', async () => {
      await run(productionStoryboardTool, harness, STORYBOARD);
      const result = await run(productionAssembleTool, harness, { compositionId: COMPOSITION_ID });
      expect(result).toMatch(/^Error: no shot has a take yet/);
    });

    it('reports the validator issues when the composition is refused', async () => {
      await run(productionStoryboardTool, harness, STORYBOARD);
      await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID, animate: false });
      harness.config.compositions.update = async () => {
        throw new UnprocessableEntityError('Invalid composition', {
          issues: [{ path: ['timeline', 'tracks', 0], message: 'bad clip' }],
        });
      };
      const result = await run(productionAssembleTool, harness, { compositionId: COMPOSITION_ID });
      expect(result).toBe('Error: the production was not saved (Invalid composition: timeline.tracks.0: bad clip).');
    });
  });

  it('storyboards a 2 minute short film in the most shots one call takes, with no product photo', async () => {
    Object.assign(harness.composition(), { template: 'short_film', timeline: defaultStudioTimeline('short_film') });
    const beats = ['opening', 'setup', 'inciting incident', 'rising action', 'turn', 'climax', 'resolution'];
    const shots = Array.from({ length: STORYBOARD_MAX_SHOTS }, (_, index) => ({
      title: `Scene ${index + 1}`,
      intent: beats[Math.min(index, beats.length - 1)],
      prompt: `The lighthouse keeper at dusk, scene ${index + 1}`,
      durationSeconds: 10,
      voiceLine: `Line ${index + 1} of the story.`,
    }));
    const result = JSON.parse(await run(productionStoryboardTool, harness, { compositionId: COMPOSITION_ID, shots }));
    expect(result.totalSeconds).toBe(120);
    expect(harness.composition().shots).toHaveLength(STORYBOARD_MAX_SHOTS);
    expect(harness.composition().brandKit.productFileIds).toEqual([]);

    await expect(
      run(productionStoryboardTool, harness, {
        compositionId: COMPOSITION_ID,
        shots: [...shots, { ...shots[0], prompt: 'One scene too many for a call' }],
      })
    ).rejects.toThrow();
  });

  it('refuses a new shot without a prompt', async () => {
    const result = await run(productionStoryboardTool, harness, {
      compositionId: COMPOSITION_ID,
      shots: [{ title: 'Opening', durationSeconds: 5 }],
    });
    expect(result).toMatch(/^Error: a new shot needs a title, a prompt and durationSeconds/);
  });

  it('is unavailable without a production tool config', async () => {
    const { toolFn } = productionStoryboardTool.implementation(harness.context, undefined);
    await expect(toolFn(STORYBOARD)).resolves.toEqual(expect.stringContaining('not available'));
  });
});
