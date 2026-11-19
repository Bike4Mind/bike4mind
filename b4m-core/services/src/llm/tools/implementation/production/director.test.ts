import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_MODEL_CATALOG,
  NotFoundError,
  UnprocessableEntityError,
  defaultStudioTimeline,
  studioCompositionFileIds,
  validateStudioComposition,
  type ImageModels,
  type StudioCompositionUpdateInput,
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

vi.mock('./audio', () => ({ createProductionAudio: vi.fn() }));

const COMPOSITION_ID = '5'.repeat(24);
const PRODUCT_FILE_ID = 'ab'.repeat(12);

const referenceModel = (Object.keys(IMAGE_MODEL_CATALOG) as ImageModels[]).find(
  id => (IMAGE_MODEL_CATALOG[id].modes.generate?.inputs.reference?.max ?? 0) > 0
);
if (!referenceModel) throw new Error('the image catalog has no model that takes reference images');

type Harness = {
  config: ProductionToolConfig;
  context: ToolContext;
  statusUpdate: ReturnType<typeof vi.fn>;
  composition(): ProductionComposition;
  counts: { image: number; video: number; music: number; speech: number; sfx: number };
  imageRequests: { request: unknown; count: number }[];
};

/** An in-memory production: the real validator guards every write, as the real composition service does. */
function createHarness(): Harness {
  let nextFile = 1;
  const newFileId = () => (nextFile++).toString(16).padStart(24, '0');
  const knownFileIds = new Set<string>([PRODUCT_FILE_ID]);
  const makeFile = () => {
    const id = newFileId();
    knownFileIds.add(id);
    return id;
  };
  const jobs = new Map<string, ProductionJobView>();
  const counts = { image: 0, video: 0, music: 0, speech: 0, sfx: 0 };
  const imageRequests: Harness['imageRequests'] = [];
  let nextJob = 1;
  const startJob = (kind: 'image' | 'video' | 'music', durationSeconds?: number) => {
    const id = `job-${kind}-${nextJob++}`;
    jobs.set(id, {
      id,
      state: 'succeeded',
      fileId: makeFile(),
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
    brandKit: { colors: ['#112233'], productFileIds: [] },
    shots: [],
    timeline: defaultStudioTimeline('blank'),
  };

  const image: ImageToolConfig = {
    selection: undefined,
    createJobs: async input => {
      imageRequests.push({ request: input.request, count: input.count });
      const ids = Array.from({ length: input.count }, () => startJob('image'));
      return { ok: true, groupId: 'group', jobs: ids.map(id => ({ id })), created: true } as never;
    },
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
      return { ok: true, fileId: makeFile(), durationMs: 1500 };
    },
    soundEffect: async () => {
      counts.sfx += 1;
      return { ok: true, fileId: makeFile(), durationMs: 800 };
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

  return { config, context, statusUpdate, composition: () => stored, counts, imageRequests };
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
    expect(final.timeline.tracks.map(track => track.id)).toEqual([
      DIRECTOR_TRACK_IDS.video,
      DIRECTOR_TRACK_IDS.music,
      DIRECTOR_TRACK_IDS.voice,
      DIRECTOR_TRACK_IDS.sfx,
      DIRECTOR_TRACK_IDS.captions,
    ]);
  });

  it('clears the old cut when the storyboard is replaced', async () => {
    await run(productionStoryboardTool, harness, STORYBOARD);
    await run(productionGenerateShotTool, harness, { compositionId: COMPOSITION_ID });
    await run(productionAddAudioTool, harness, { compositionId: COMPOSITION_ID, voiceover: true });
    await run(productionAssembleTool, harness, { compositionId: COMPOSITION_ID });
    expect(directorClips(harness.composition().timeline, 'voice')).toHaveLength(3);

    await run(productionStoryboardTool, harness, { ...STORYBOARD, replace: true });
    const timeline = harness.composition().timeline;
    for (const kind of ['video', 'music', 'voice', 'sfx', 'captions'] as const) {
      expect(directorClips(timeline, kind)).toEqual([]);
    }
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
    expect(harness.composition().shots.map(shot => shot.fileIds.length > 0)).toEqual([true, false, true]);
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
        index === 0 ? { ...shot, durationSeconds: 20 } : { ...shot, voiceLine: 'Shorter.' }
      ),
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
    expect(after.every(shot => shot.voiceLine === 'Shorter.' || shot.id === 'shot-1')).toBe(true);
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
    };
    expect(await run(productionStoryboardTool, harness, rewritten)).not.toMatch(/^Error/);
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
    expect(result.notes.join(' ')).toContain('the voice line for shot-1 runs 5000 ms');
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

  it('is unavailable without a production tool config', async () => {
    const { toolFn } = productionStoryboardTool.implementation(harness.context, undefined);
    await expect(toolFn(STORYBOARD)).resolves.toEqual(expect.stringContaining('not available'));
  });
});
