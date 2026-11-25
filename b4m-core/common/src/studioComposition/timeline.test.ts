import { describe, expect, it } from 'vitest';
import { StudioTimelineSchema, studioTimelineFileIds, type StudioTimelineInput } from './timeline';
import { studioFileMediaKind, validateStudioTimeline } from './validateTimeline';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);

const baseTimeline = (overrides: Partial<StudioTimelineInput> = {}): StudioTimelineInput => ({
  version: 1,
  durationMs: 15_000,
  fps: 30,
  outputs: [{ id: 'out-16x9', aspectRatio: '16:9', width: 1920, height: 1080 }],
  tracks: [
    {
      id: 'video-1',
      kind: 'video',
      clips: [
        { id: 'v1', fileId: FILE_A, startMs: 0, durationMs: 5000 },
        { id: 'v2', fileId: FILE_B, startMs: 5000, durationMs: 5000, trimStartMs: 1000 },
      ],
    },
    {
      id: 'music-1',
      kind: 'music',
      clips: [{ id: 'm1', fileId: FILE_A, startMs: 0, durationMs: 15_000, fadeOutMs: 2000 }],
    },
    {
      id: 'captions-1',
      kind: 'captions',
      clips: [{ id: 'c1', text: 'Ride further', startMs: 1000, durationMs: 3000 }],
    },
  ],
  ...overrides,
});

const parse = (input: StudioTimelineInput) => StudioTimelineSchema.parse(input);

describe('StudioTimelineSchema', () => {
  it('parses a valid spec and fills the clip defaults', () => {
    const timeline = parse(baseTimeline());
    const [video, music, captions] = timeline.tracks;
    expect(video.kind === 'video' && video.clips[0]).toMatchObject({ trimStartMs: 0, volume: 1, fit: 'cover' });
    expect(music.kind === 'music' && music.clips[0]).toMatchObject({ volume: 1, fadeInMs: 0, fadeOutMs: 2000 });
    expect(captions.kind === 'captions' && captions.clips[0].style).toEqual({
      position: 'bottom',
      align: 'center',
      fontSizePct: 5,
      maxWidthPct: 90,
      color: '#FFFFFF',
    });
    expect(validateStudioTimeline(timeline)).toEqual([]);
  });

  it.each([
    ['an unknown version', { version: 2 }],
    ['an unsupported fps', { fps: 29 }],
    ['no outputs', { outputs: [] }],
    ['a non-integer duration', { durationMs: 1.5 }],
    ['a duration past the cap', { durationMs: 31 * 60 * 1000 }],
  ])('rejects %s', (_label, overrides) => {
    expect(StudioTimelineSchema.safeParse(baseTimeline(overrides as Partial<StudioTimelineInput>)).success).toBe(false);
  });

  it('rejects a media clip whose file id is not a lowercase ObjectId', () => {
    const tracks: StudioTimelineInput['tracks'] = [
      { id: 'voice-1', kind: 'voice', clips: [{ id: 'vo1', fileId: 'A'.repeat(24), startMs: 0, durationMs: 1000 }] },
    ];
    expect(StudioTimelineSchema.safeParse(baseTimeline({ tracks })).success).toBe(false);
  });

  it('rejects a clip shape that does not match its track kind', () => {
    const tracks = [
      { id: 'captions-1', kind: 'captions', clips: [{ id: 'x', fileId: FILE_A, startMs: 0, durationMs: 1 }] },
    ];
    expect(StudioTimelineSchema.safeParse(baseTimeline({ tracks } as Partial<StudioTimelineInput>)).success).toBe(
      false
    );
  });

  it('leaves crop unset on a clip that has none, so old specs keep the centre crop', () => {
    const [video] = parse(baseTimeline()).tracks;
    expect(video.kind === 'video' && video.clips[0].crop).toBeUndefined();
  });

  const withCrop = (crop: unknown) =>
    baseTimeline({
      tracks: [
        { id: 'video-1', kind: 'video', clips: [{ id: 'v1', fileId: FILE_A, startMs: 0, durationMs: 5000, crop }] },
      ],
    } as Partial<StudioTimelineInput>);

  it('keeps a per-aspect-ratio crop rect, including one flush with the frame edge', () => {
    const crop = {
      '9:16': { x: 0.1, y: 0, width: 0.316406, height: 1 },
      '1:1': { x: 0.4375, y: 0, width: 0.5625, height: 1 },
    };
    const [video] = parse(withCrop(crop)).tracks;
    expect(video.kind === 'video' && video.clips[0].crop).toEqual(crop);
  });

  it.each([
    ['a rect past the right edge', { '9:16': { x: 0.8, y: 0, width: 0.3, height: 1 } }],
    ['a rect past the bottom edge', { '9:16': { x: 0, y: 0.5, width: 0.3, height: 0.6 } }],
    ['a negative origin', { '9:16': { x: -0.1, y: 0, width: 0.3, height: 1 } }],
    ['a rect below the minimum edge', { '9:16': { x: 0, y: 0, width: 0.01, height: 1 } }],
    ['an unknown aspect ratio key', { '3:2': { x: 0, y: 0, width: 0.5, height: 1 } }],
  ])('rejects %s', (_label, crop) => {
    expect(StudioTimelineSchema.safeParse(withCrop(crop)).success).toBe(false);
  });

  it('lists each referenced file once, skipping captions', () => {
    expect(studioTimelineFileIds(parse(baseTimeline()))).toEqual([FILE_A, FILE_B]);
  });
});

describe('validateStudioTimeline', () => {
  const codes = (input: StudioTimelineInput, context?: Parameters<typeof validateStudioTimeline>[1]) =>
    validateStudioTimeline(parse(input), context).map(issue => [issue.code, issue.path.join('.')]);

  it('flags overlapping clips on one track but allows back-to-back clips', () => {
    const tracks: StudioTimelineInput['tracks'] = [
      {
        id: 'sfx-1',
        kind: 'sfx',
        clips: [
          { id: 's2', fileId: FILE_A, startMs: 900, durationMs: 500 },
          { id: 's1', fileId: FILE_A, startMs: 0, durationMs: 1000 },
          { id: 's3', fileId: FILE_A, startMs: 1400, durationMs: 100 },
        ],
      },
    ];
    expect(codes(baseTimeline({ tracks }))).toEqual([['clip_overlap', 'tracks.0.clips.0']]);
  });

  it('flags every clip a long clip spans, not only its neighbour', () => {
    const tracks: StudioTimelineInput['tracks'] = [
      {
        id: 'video-1',
        kind: 'video',
        clips: [
          { id: 'long', fileId: FILE_A, startMs: 0, durationMs: 10_000 },
          { id: 'b', fileId: FILE_A, startMs: 1000, durationMs: 1000 },
          { id: 'c', fileId: FILE_A, startMs: 3000, durationMs: 1000 },
        ],
      },
    ];
    expect(codes(baseTimeline({ tracks }))).toEqual([
      ['clip_overlap', 'tracks.0.clips.1'],
      ['clip_overlap', 'tracks.0.clips.2'],
    ]);
  });

  it('allows the same span on two tracks of one kind', () => {
    const clip = { fileId: FILE_A, startMs: 0, durationMs: 1000 };
    const tracks: StudioTimelineInput['tracks'] = [
      { id: 'sfx-1', kind: 'sfx', clips: [{ id: 's1', ...clip }] },
      { id: 'sfx-2', kind: 'sfx', clips: [{ id: 's2', ...clip }] },
    ];
    expect(codes(baseTimeline({ tracks }))).toEqual([]);
  });

  it('flags a clip that runs past the end of the timeline', () => {
    const tracks: StudioTimelineInput['tracks'] = [
      { id: 'voice-1', kind: 'voice', clips: [{ id: 'vo1', fileId: FILE_A, startMs: 14_000, durationMs: 2000 }] },
    ];
    expect(codes(baseTimeline({ tracks }))).toEqual([['clip_out_of_bounds', 'tracks.0.clips.0']]);
  });

  it('flags fades longer than their clip', () => {
    const tracks: StudioTimelineInput['tracks'] = [
      {
        id: 'music-1',
        kind: 'music',
        clips: [{ id: 'm1', fileId: FILE_A, startMs: 0, durationMs: 1000, fadeInMs: 600, fadeOutMs: 600 }],
      },
    ];
    expect(codes(baseTimeline({ tracks }))).toEqual([['fade_too_long', 'tracks.0.clips.0']]);
  });

  it('flags duplicate ids across tracks and clips', () => {
    const tracks: StudioTimelineInput['tracks'] = [
      { id: 'dup', kind: 'captions', clips: [{ id: 'dup', text: 'Hi', startMs: 0, durationMs: 100 }] },
    ];
    expect(codes(baseTimeline({ tracks }))).toEqual([['duplicate_id', 'tracks.0.clips.0.id']]);
  });

  it('flags output sizes ffmpeg cannot encode or that miss their aspect ratio', () => {
    const outputs: StudioTimelineInput['outputs'] = [
      { id: 'odd', aspectRatio: '1:1', width: 1081, height: 1081 },
      { id: 'wrong', aspectRatio: '9:16', width: 1920, height: 1080 },
      { id: 'rounded', aspectRatio: '16:9', width: 1366, height: 768 },
    ];
    expect(codes(baseTimeline({ outputs, tracks: [] }))).toEqual([
      ['odd_output_edge', 'outputs.0'],
      ['aspect_ratio_mismatch', 'outputs.1'],
    ]);
  });

  it('checks references and trims only against what the context knows', () => {
    const input = baseTimeline();
    expect(codes(input, { knownFileIds: new Set([FILE_A]) })).toEqual([['unknown_file', 'tracks.0.clips.1.fileId']]);
    // v2 plays 1000..6000ms of FILE_B; m1 plays 0..15000ms of FILE_A, which is not probed here.
    expect(codes(input, { sourceDurationsMs: new Map([[FILE_B, 5500]]) })).toEqual([
      ['trim_out_of_bounds', 'tracks.0.clips.1'],
    ]);
  });

  it('flags a file whose kind its track cannot play', () => {
    const fileKinds = new Map([
      [FILE_A, studioFileMediaKind('audio/mpeg')],
      [FILE_B, studioFileMediaKind('image/png')],
    ]);
    // FILE_A is audio: fine on the music track, not on the video track. FILE_B is an image still on video.
    expect(codes(baseTimeline(), { fileKinds })).toEqual([['unsupported_file_kind', 'tracks.0.clips.0.fileId']]);
  });
});

describe('studioFileMediaKind', () => {
  it.each([
    ['video/mp4', 'video'],
    ['IMAGE/PNG', 'image'],
    ['audio/wav', 'audio'],
    ['application/pdf', 'other'],
    ['', 'other'],
  ])('maps %s to %s', (mimeType, kind) => {
    expect(studioFileMediaKind(mimeType)).toBe(kind);
  });
});
