import { describe, expect, it } from 'vitest';
import {
  STUDIO_COMPOSITION_TEMPLATES,
  StudioCompositionContentSchema,
  StudioCompositionCreateInputSchema,
  StudioCompositionUpdateInputSchema,
  defaultStudioTimeline,
  studioCompositionFileIds,
} from './composition';
import { StudioTimelineSchema } from './timeline';
import { validateStudioComposition } from './validateComposition';
import { validateStudioTimeline } from './validateTimeline';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);
const FILE_C = 'c'.repeat(24);

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
  });
});

describe('StudioCompositionCreateInputSchema', () => {
  it('needs only a title and defaults the rest', () => {
    const parsed = StudioCompositionCreateInputSchema.parse({ title: '  Spring ad  ' });
    expect(parsed).toEqual({
      title: 'Spring ad',
      template: 'ad_campaign',
      brief: {},
      brandKit: { colors: [], productFileIds: [] },
      shots: [],
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
    brandKit: { logoFileId: FILE_A, productFileIds: [FILE_B] },
    shots: [
      { id: 'shot-1', title: 'Opening', fileIds: [FILE_B, FILE_C] },
      { id: 'shot-1', title: 'Duplicate' },
    ],
    timeline: {
      ...defaultStudioTimeline('ad_campaign'),
      tracks: [{ id: 'video-1', kind: 'video', clips: [{ id: 'v1', fileId: FILE_C, startMs: 0, durationMs: 20_000 }] }],
    },
  });

  it('collects every referenced file once', () => {
    expect(studioCompositionFileIds(content)).toEqual([FILE_A, FILE_B, FILE_C]);
  });

  it('reports timeline issues under `timeline`, duplicate shots and unknown files', () => {
    const issues = validateStudioComposition(content, { knownFileIds: new Set([FILE_A, FILE_C]) });
    expect(issues.map(issue => [issue.code, issue.path.join('.')])).toEqual([
      ['clip_out_of_bounds', 'timeline.tracks.0.clips.0'],
      ['duplicate_id', 'shots.1.id'],
      ['unknown_file', 'brandKit.productFileIds.0'],
      ['unknown_file', 'shots.0.fileIds.0'],
    ]);
  });
});
