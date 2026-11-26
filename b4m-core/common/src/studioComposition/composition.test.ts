import { describe, expect, it } from 'vitest';
import {
  STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS,
  STUDIO_COMPOSITION_TEMPLATES,
  STUDIO_SHORT_FILM_ASPECTS,
  STUDIO_SHORT_FILM_LENGTHS_MS,
  StudioCompositionBriefSchema,
  StudioCompositionContentSchema,
  StudioCompositionCreateInputSchema,
  StudioCompositionUpdateInputSchema,
  defaultStudioShots,
  defaultStudioTimeline,
  studioCompositionFileIds,
} from './composition';
import { StudioTimelineSchema } from './timeline';
import { validateStudioComposition } from './validateComposition';
import { validateStudioTimeline } from './validateTimeline';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);
const FILE_C = 'c'.repeat(24);
const FILE_D = 'd'.repeat(24);
const FILE_E = 'e'.repeat(24);

describe('defaultStudioTimeline', () => {
  it.each(STUDIO_COMPOSITION_TEMPLATES)('gives %s a schema-valid, rule-valid empty timeline', template => {
    const timeline = defaultStudioTimeline(template);
    expect(StudioTimelineSchema.parse(timeline)).toEqual(timeline);
    expect(validateStudioTimeline(timeline)).toEqual([]);
  });

  it('starts an ad campaign at 15s in every placement shape', () => {
    const timeline = defaultStudioTimeline('ad_campaign');
    expect(timeline.durationMs).toBe(15_000);
    expect(timeline.outputs.map(output => output.aspectRatio)).toEqual(['16:9', '9:16', '1:1']);
    expect(timeline.tracks.map(track => track.kind)).toEqual(['video', 'voice', 'music', 'captions']);
  });

  it('starts a short film at 60s in 16:9 with narration, effects, music and caption lanes', () => {
    const timeline = defaultStudioTimeline('short_film');
    expect(timeline.durationMs).toBe(60_000);
    expect(timeline.outputs.map(output => output.aspectRatio)).toEqual(['16:9']);
    expect(timeline.tracks.map(track => track.kind)).toEqual(['video', 'voice', 'sfx', 'music', 'captions']);
  });

  it.each(STUDIO_SHORT_FILM_LENGTHS_MS)('sizes a short film to a chosen %i ms in every chosen shape', durationMs => {
    const timeline = defaultStudioTimeline('short_film', { durationMs, aspects: STUDIO_SHORT_FILM_ASPECTS });
    expect(timeline.durationMs).toBe(durationMs);
    expect(timeline.outputs).toEqual([
      { id: 'out-16x9', aspectRatio: '16:9', width: 1920, height: 1080 },
      { id: 'out-9x16', aspectRatio: '9:16', width: 1080, height: 1920 },
      { id: 'out-1x1', aspectRatio: '1:1', width: 1080, height: 1080 },
      { id: 'out-4x5', aspectRatio: '4:5', width: 1080, height: 1350 },
    ]);
    expect(StudioTimelineSchema.parse(timeline)).toEqual(timeline);
    expect(validateStudioTimeline(timeline)).toEqual([]);
  });

  it('keeps the default length when only the shapes are chosen', () => {
    const timeline = defaultStudioTimeline('short_film', { aspects: ['9:16'] });
    expect(timeline.durationMs).toBe(60_000);
    expect(timeline.outputs.map(output => output.aspectRatio)).toEqual(['9:16']);
  });

  it('offers short film lengths from 30s to 2 minutes, all within the timeline limit', () => {
    expect(STUDIO_SHORT_FILM_LENGTHS_MS).toEqual([30_000, 60_000, 90_000, 120_000]);
    expect(STUDIO_SHORT_FILM_LENGTHS_MS).toContain(STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS.short_film.durationMs);
    expect(
      STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS.short_film.aspects.every(a => STUDIO_SHORT_FILM_ASPECTS.includes(a))
    ).toBe(true);
  });
});

describe('defaultStudioShots', () => {
  it.each(STUDIO_COMPOSITION_TEMPLATES)('gives %s schema-valid starter shots with unique ids', template => {
    const shots = defaultStudioShots(template);
    expect(StudioCompositionContentSchema.shape.shots.parse(shots)).toEqual(shots);
    expect(new Set(shots.map(shot => shot.id)).size).toBe(shots.length);
    expect(shots).toHaveLength(STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS[template].starterShots.length);
  });

  it('outlines an ad campaign as hook, product, benefit and call to action', () => {
    expect(defaultStudioShots('ad_campaign').map(shot => shot.intent)).toEqual([
      'hook',
      'product reveal',
      'benefit',
      'call to action',
    ]);
  });

  it('outlines a short film as a beginning, middle and end', () => {
    expect(defaultStudioShots('short_film').map(({ title, intent }) => [title, intent])).toEqual([
      ['Opening', 'opening'],
      ['Inciting moment', 'inciting incident'],
      ['Climax', 'climax'],
      ['Resolution', 'resolution'],
    ]);
  });
});

describe('StudioCompositionBriefSchema', () => {
  it('takes a trimmed tone and refuses one past the field limit', () => {
    expect(StudioCompositionBriefSchema.parse({ tone: '  wistful  ' })).toEqual({ tone: 'wistful' });
    expect(StudioCompositionBriefSchema.safeParse({ tone: 'x'.repeat(500) }).success).toBe(true);
    expect(StudioCompositionBriefSchema.safeParse({ tone: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('StudioCompositionCreateInputSchema', () => {
  it('needs only a title and defaults the rest', () => {
    const parsed = StudioCompositionCreateInputSchema.parse({ title: '  Spring ad  ' });
    expect(parsed).toEqual({
      title: 'Spring ad',
      template: 'ad_campaign',
      brief: {},
      brandKit: { colors: [], productFileIds: [], characters: [] },
    });
  });

  it.each([
    ['a server-owned field', { title: 'x', userId: 'someone' }],
    ['an organization id', { title: 'x', organizationId: FILE_A }],
    ['an empty title', { title: '   ' }],
    ['an unknown template', { title: 'x', template: 'podcast' }],
    ['a bad brand color', { title: 'x', brandKit: { colors: ['red'] } }],
  ])('rejects %s', (_label, body) => {
    expect(StudioCompositionCreateInputSchema.safeParse(body).success).toBe(false);
  });
});

describe('StudioCompositionUpdateInputSchema', () => {
  it('accepts null to unlink a project', () => {
    expect(StudioCompositionUpdateInputSchema.parse({ projectId: null })).toEqual({ projectId: null });
  });

  it('rejects an empty patch', () => {
    expect(StudioCompositionUpdateInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('composition references', () => {
  const content = StudioCompositionContentSchema.parse({
    title: 'Spring ad',
    brief: { summary: 'Cold brew, hot summer', productFileId: FILE_D },
    brandKit: { logoFileId: FILE_A, productFileIds: [FILE_B] },
    shots: [
      {
        id: 'shot-1',
        title: 'Opening',
        prompt: 'A can on ice',
        voiceLine: 'Summer, served cold.',
        fileIds: [FILE_B, FILE_C],
        chosenFileId: FILE_C,
        clipFileId: FILE_E,
      },
      { id: 'shot-1', title: 'Duplicate', chosenFileId: FILE_A },
    ],
    timeline: {
      ...defaultStudioTimeline('ad_campaign'),
      tracks: [{ id: 'video-1', kind: 'video', clips: [{ id: 'v1', fileId: FILE_C, startMs: 0, durationMs: 20_000 }] }],
    },
  });

  it('collects every referenced file once', () => {
    expect(studioCompositionFileIds(content)).toEqual([FILE_D, FILE_A, FILE_B, FILE_C, FILE_E]);
  });

  it('collects nothing from a production with no files', () => {
    const empty = StudioCompositionContentSchema.parse({
      title: 'Empty',
      shots: [{ id: 'shot-1', title: 'Opening' }],
      timeline: defaultStudioTimeline('short_film'),
    });
    expect(studioCompositionFileIds(empty)).toEqual([]);
  });

  it('reports timeline issues under `timeline`, duplicate shots, stray chosen takes and unknown files', () => {
    const issues = validateStudioComposition(content, { knownFileIds: new Set([FILE_A, FILE_C, FILE_D, FILE_E]) });
    expect(issues.map(issue => [issue.code, issue.path.join('.')])).toEqual([
      ['clip_out_of_bounds', 'timeline.tracks.0.clips.0'],
      ['duplicate_id', 'shots.1.id'],
      ['unknown_take', 'shots.1.chosenFileId'],
      ['unknown_file', 'brandKit.productFileIds.0'],
      ['unknown_file', 'shots.0.fileIds.0'],
    ]);
  });

  it('accepts only a video as a shot clip', () => {
    const issues = validateStudioComposition(content, { fileKinds: new Map([[FILE_E, 'image' as const]]) });
    expect(issues.map(issue => [issue.code, issue.path.join('.')])).toContainEqual([
      'unsupported_file_kind',
      'shots.0.clipFileId',
    ]);
  });

  it('accepts only an image as the product photo', () => {
    const issues = validateStudioComposition(
      { ...content, shots: [] },
      { fileKinds: new Map([[FILE_D, 'video' as const]]) }
    );
    expect(issues.map(issue => [issue.code, issue.path.join('.')])).toContainEqual([
      'unsupported_file_kind',
      'brief.productFileId',
    ]);
  });
});

describe('shot picks', () => {
  const withShot = (shot: Record<string, unknown>) =>
    StudioCompositionContentSchema.parse({
      title: 'Picks',
      shots: [{ id: 's1', title: 'One', ...shot }],
      timeline: defaultStudioTimeline('blank'),
    });

  it('accepts a pick and a clip drawn from the shot files', () => {
    const content = withShot({ fileIds: [FILE_A, FILE_B], chosenFileId: FILE_A, clipFileId: FILE_B });
    expect(validateStudioComposition(content)).toEqual([]);
  });

  it('refuses a pick outside the shot takes; a clip is its own file, not a take', () => {
    const content = withShot({ fileIds: [FILE_A], chosenFileId: FILE_B, clipFileId: FILE_C });
    expect(validateStudioComposition(content).map(issue => [issue.code, issue.path.join('.')])).toEqual([
      ['unknown_take', 'shots.0.chosenFileId'],
    ]);
  });
});
