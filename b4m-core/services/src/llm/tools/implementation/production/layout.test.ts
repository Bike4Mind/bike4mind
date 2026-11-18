import { describe, expect, it } from 'vitest';
import {
  defaultStudioTimeline,
  type StudioShot,
  type StudioTimeline,
  type StudioTimelineTrack,
} from '@bike4mind/common';
import {
  DEFAULT_SHOT_DURATION_MS,
  DIRECTOR_TRACK_IDS,
  buildCaptionClips,
  buildMusicClip,
  buildSfxClips,
  buildVideoClips,
  buildVoiceClips,
  directorClips,
  layoutShots,
  shotPicture,
  shotsTooShortForVoice,
  withDirectorTracks,
  type ShotSlot,
} from './layout';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);
const FILE_C = 'c'.repeat(24);

const shot = (id: string, extra: Partial<StudioShot> = {}): StudioShot => ({ id, title: id, fileIds: [], ...extra });

const audioClip = (id: string, startMs: number, durationMs: number, extra: Record<string, unknown> = {}) => ({
  id,
  startMs,
  durationMs,
  fileId: FILE_A,
  trimStartMs: 0,
  volume: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  ...extra,
});

const timelineWith = (tracks: unknown[]): StudioTimeline =>
  ({ ...defaultStudioTimeline('blank'), tracks }) as unknown as StudioTimeline;

const track = (id: string, kind: string, clips: unknown[]) => ({ id, kind, enabled: true, clips });

const trackIds = (timeline: StudioTimeline) => timeline.tracks.map(item => item.id);

describe('layoutShots', () => {
  it('places shots end to end from zero in storyboard order', () => {
    const { slots, totalMs } = layoutShots([
      shot('s1', { durationMs: 2000 }),
      shot('s2', { durationMs: 3000 }),
      shot('s3', { durationMs: 1500 }),
    ]);
    expect(slots.map(slot => [slot.shot.id, slot.index, slot.startMs, slot.durationMs])).toEqual([
      ['s1', 0, 0, 2000],
      ['s2', 1, 2000, 3000],
      ['s3', 2, 5000, 1500],
    ]);
    expect(totalMs).toBe(6500);
  });

  it('gives a shot without a duration the default and skips no shot', () => {
    const { slots, totalMs } = layoutShots([shot('s1'), shot('s2', { durationMs: 1000 }), shot('s3')]);
    expect(DEFAULT_SHOT_DURATION_MS).toBe(4000);
    expect(slots.map(slot => slot.durationMs)).toEqual([4000, 1000, 4000]);
    expect(slots.map(slot => slot.startMs)).toEqual([0, 4000, 5000]);
    expect(totalMs).toBe(9000);
  });

  it('returns an empty layout for no shots', () => {
    expect(layoutShots([])).toEqual({ slots: [], totalMs: 0 });
  });
});

describe('shotPicture', () => {
  it('prefers the clip over the chosen still, and is undefined with neither', () => {
    expect(shotPicture(shot('s', { chosenFileId: FILE_A, clipFileId: FILE_B }))).toBe(FILE_B);
    expect(shotPicture(shot('s', { chosenFileId: FILE_A }))).toBe(FILE_A);
    expect(shotPicture(shot('s'))).toBeUndefined();
  });
});

describe('buildVideoClips', () => {
  it('makes a muted cover clip per shot that has a picture, at its slot', () => {
    const { slots } = layoutShots([
      shot('s1', { durationMs: 2000, clipFileId: FILE_A, chosenFileId: FILE_B }),
      shot('s2', { durationMs: 3000 }),
      shot('s3', { durationMs: 1000, chosenFileId: FILE_C }),
    ]);
    expect(buildVideoClips(slots)).toEqual([
      expect.objectContaining({
        id: 's1-video',
        startMs: 0,
        durationMs: 2000,
        fileId: FILE_A,
        volume: 0,
        fit: 'cover',
      }),
      expect.objectContaining({ id: 's3-video', startMs: 5000, durationMs: 1000, fileId: FILE_C, volume: 0 }),
    ]);
  });
});

describe('buildCaptionClips', () => {
  it('makes a caption per shot with a voice line, spanning the shot', () => {
    const { slots } = layoutShots([
      shot('s1', { durationMs: 2000, voiceLine: 'Hello' }),
      shot('s2', { durationMs: 3000 }),
      shot('s3', { durationMs: 1000, voiceLine: 'Bye' }),
    ]);
    expect(buildCaptionClips(slots)).toEqual([
      expect.objectContaining({ id: 's1-caption', startMs: 0, durationMs: 2000, text: 'Hello' }),
      expect.objectContaining({ id: 's3-caption', startMs: 5000, durationMs: 1000, text: 'Bye' }),
    ]);
  });
});

describe('buildVoiceClips', () => {
  const slotsFor = (durations: number[]): ShotSlot[] =>
    layoutShots(durations.map((durationMs, index) => shot(`s${index + 1}`, { durationMs }))).slots;

  it('starts each line shortly after its shot', () => {
    const [first, second] = slotsFor([3000, 3000]) as [ShotSlot, ShotSlot];
    const clips = buildVoiceClips(
      [
        { id: 'v1', fileId: FILE_A, durationMs: 1000, slot: first },
        { id: 'v2', fileId: FILE_B, durationMs: 1000, slot: second },
      ],
      6000
    );
    expect(clips.map(clip => [clip.id, clip.startMs, clip.durationMs])).toEqual([
      ['v1', 200, 1000],
      ['v2', 3200, 1000],
    ]);
  });

  it('keeps each line on its own shot: a long line is cut where the next one starts', () => {
    const [first, second] = slotsFor([2000, 2000]) as [ShotSlot, ShotSlot];
    const clips = buildVoiceClips(
      [
        { id: 'v1', fileId: FILE_A, durationMs: 3500, slot: first },
        { id: 'v2', fileId: FILE_B, durationMs: 500, slot: second },
      ],
      4000
    );
    expect(clips.map(clip => [clip.startMs, clip.durationMs])).toEqual([
      [200, 2000],
      [2200, 500],
    ]);
  });

  it('runs a line on past its shot when the next shot has no line', () => {
    const [first, , third] = slotsFor([2000, 2000, 2000]) as [ShotSlot, ShotSlot, ShotSlot];
    const clips = buildVoiceClips(
      [
        { id: 'v1', fileId: FILE_A, durationMs: 3000, slot: first },
        { id: 'v3', fileId: FILE_B, durationMs: 500, slot: third },
      ],
      6000
    );
    expect(clips.map(clip => [clip.startMs, clip.durationMs])).toEqual([
      [200, 3000],
      [4200, 500],
    ]);
  });

  it('cuts the last line at the end of the timeline and drops one that starts past it', () => {
    const [first, second] = slotsFor([2000, 2000]) as [ShotSlot, ShotSlot];
    const clips = buildVoiceClips(
      [
        { id: 'v1', fileId: FILE_A, durationMs: 500, slot: first },
        { id: 'v2', fileId: FILE_B, durationMs: 9000, slot: second },
      ],
      4000
    );
    expect(clips.map(clip => [clip.id, clip.startMs, clip.durationMs])).toEqual([
      ['v1', 200, 500],
      ['v2', 2200, 1800],
    ]);
    expect(buildVoiceClips([{ id: 'v3', fileId: FILE_C, durationMs: 500, slot: second }], 2100)).toEqual([]);
  });
});

describe('shotsTooShortForVoice', () => {
  const spoken = (id: string, durationMs: number): StudioShot => shot(id, { durationMs, voiceLine: `Line ${id}.` });
  const shots = [spoken('a', 4000), spoken('b', 4000)];
  const placed = (lineMs: Record<string, number>) =>
    timelineWith([
      track(
        DIRECTOR_TRACK_IDS.voice,
        'voice',
        Object.entries(lineMs).map(([id, durationMs]) => audioClip(`${id}-voice`, 0, durationMs))
      ),
    ]);

  it('gives a line followed by another spoken line the full length of its shot', () => {
    expect(shotsTooShortForVoice(placed({ a: 4000, b: 3800 }), shots, shots)).toEqual([]);
  });

  it('takes the lead-in off the last spoken line, which the end of the cut caps', () => {
    expect(shotsTooShortForVoice(placed({ a: 4000, b: 4000 }), shots, shots)).toEqual([
      { id: 'b', lineMs: 4000, roomMs: 3800 },
    ]);
  });
});

describe('buildMusicClip', () => {
  const music = { id: 'music-bed', fileId: FILE_A, durationMs: 10_000 };

  it('plays quieter under a voiceover than alone', () => {
    const under = buildMusicClip(music, 10_000, true);
    const alone = buildMusicClip(music, 10_000, false);
    expect(under.volume).toBeLessThan(alone.volume);
    expect(under).toMatchObject({ id: 'music-bed', startMs: 0, durationMs: 10_000, fadeInMs: 300, fadeOutMs: 1000 });
  });

  it('is cut to the timeline with fades that fit', () => {
    const clip = buildMusicClip(music, 1000, false);
    expect(clip.durationMs).toBe(1000);
    expect(clip.fadeInMs + clip.fadeOutMs).toBeLessThanOrEqual(clip.durationMs);
  });
});

describe('buildSfxClips', () => {
  it('starts at the shot and is never longer than the shot', () => {
    const { slots } = layoutShots([shot('s1', { durationMs: 2000 }), shot('s2', { durationMs: 1000 })]);
    const clips = buildSfxClips([
      { id: 'e1', fileId: FILE_A, durationMs: 5000, slot: slots[0]! },
      { id: 'e2', fileId: FILE_B, durationMs: 400, slot: slots[1]! },
    ]);
    expect(clips.map(clip => [clip.id, clip.startMs, clip.durationMs])).toEqual([
      ['e1', 0, 2000],
      ['e2', 2000, 400],
    ]);
  });
});

describe('withDirectorTracks', () => {
  const userTrack = track('user-music', 'music', [audioClip('u1', 0, 1000)]);

  it('keeps the user tracks and puts the director picture track first', () => {
    const video = [
      {
        id: 'v',
        startMs: 0,
        durationMs: 1000,
        fileId: FILE_A,
        trimStartMs: 0,
        volume: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        fit: 'cover',
      },
    ];
    const result = withDirectorTracks(timelineWith([userTrack]), { video }, 1000);
    expect(trackIds(result)).toEqual([DIRECTOR_TRACK_IDS.video, 'user-music']);
    expect(result.tracks[1]).toEqual(userTrack);
  });

  it('replaces only the director tracks named, keeping the others as they were', () => {
    const existing = timelineWith([
      track(DIRECTOR_TRACK_IDS.music, 'music', [audioClip('old-music', 0, 1000)]),
      track(DIRECTOR_TRACK_IDS.voice, 'music', [audioClip('old-voice', 0, 500)]),
    ]);
    const result = withDirectorTracks(existing, { music: [audioClip('new-music', 0, 800)] as never }, 2000);
    expect(directorClips(result, 'music').map(clip => clip.id)).toEqual(['new-music']);
    expect(directorClips(result, 'voice').map(clip => clip.id)).toEqual(['old-voice']);
  });

  it('drops empty director tracks but keeps an empty user track', () => {
    const existing = timelineWith([
      track(DIRECTOR_TRACK_IDS.sfx, 'music', [audioClip('x', 0, 100)]),
      track('mine', 'music', []),
    ]);
    const result = withDirectorTracks(existing, { sfx: [] }, 1000);
    expect(trackIds(result)).toEqual(['mine']);
  });

  it('orders director tracks bottom to top after the user tracks', () => {
    const result = withDirectorTracks(
      timelineWith([userTrack]),
      {
        video: [
          {
            id: 'v',
            startMs: 0,
            durationMs: 1000,
            fileId: FILE_A,
            trimStartMs: 0,
            volume: 0,
            fadeInMs: 0,
            fadeOutMs: 0,
            fit: 'cover',
          },
        ] as never,
        music: [audioClip('m', 0, 1000)] as never,
        voice: [audioClip('vo', 0, 1000)] as never,
        sfx: [audioClip('fx', 0, 1000)] as never,
        captions: [{ id: 'c', startMs: 0, durationMs: 1000, text: 't', style: {} }] as never,
      },
      1000
    );
    expect(trackIds(result)).toEqual([
      'director-video',
      'user-music',
      'director-music',
      'director-voice',
      'director-sfx',
      'director-captions',
    ]);
  });

  it('fits director clips to the new duration and sets the timeline durationMs', () => {
    const existing = timelineWith([
      track(DIRECTOR_TRACK_IDS.music, 'music', [audioClip('m', 0, 10_000, { fadeInMs: 300, fadeOutMs: 1000 })]),
      track(DIRECTOR_TRACK_IDS.sfx, 'music', [audioClip('late', 5000, 500), audioClip('edge', 4000, 500)]),
    ]);
    const result = withDirectorTracks(existing, {}, 4000);
    expect(result.durationMs).toBe(4000);
    const [music] = directorClips(result, 'music') as StudioTimelineTrack['clips'];
    expect(music).toMatchObject({ durationMs: 4000, fadeInMs: 300, fadeOutMs: 1000 });
    expect(directorClips(result, 'sfx')).toEqual([]);
    expect(trackIds(result)).not.toContain(DIRECTOR_TRACK_IDS.sfx);
  });

  it("never changes the user's clips, and runs the timeline to the end of the last one", () => {
    const mine = audioClip('mine-clip', 3000, 5000);
    const existing = timelineWith([track('mine', 'music', [mine])]);
    const result = withDirectorTracks(existing, {}, 4000);
    expect(result.tracks.find(item => item.id === 'mine')!.clips).toEqual([mine]);
    expect(result.durationMs).toBe(8000);
  });

  it('trims fades with a clip so their sum never exceeds its length', () => {
    const existing = timelineWith([
      track(DIRECTOR_TRACK_IDS.music, 'music', [audioClip('m', 0, 10_000, { fadeInMs: 800, fadeOutMs: 800 })]),
    ]);
    const [clip] = directorClips(withDirectorTracks(existing, {}, 1000), 'music') as unknown as {
      durationMs: number;
      fadeInMs: number;
      fadeOutMs: number;
    }[];
    expect(clip!.durationMs).toBe(1000);
    expect(clip!.fadeInMs + clip!.fadeOutMs).toBeLessThanOrEqual(1000);
  });
});
