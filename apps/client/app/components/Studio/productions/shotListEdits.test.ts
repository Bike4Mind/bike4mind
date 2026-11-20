import { describe, expect, it } from 'vitest';
import { defaultStudioTimeline, validateStudioTimeline, type StudioShot } from '@bike4mind/common';
import {
  addShot,
  addTakes,
  chooseTake,
  moveShot,
  removeShot,
  removeTake,
  sendShotsToTimeline,
  updateShot,
} from './shotListEdits';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);
const FILE_C = 'c'.repeat(24);
const FILE_D = 'd'.repeat(24);
const AUDIO = 'e'.repeat(24);

const shot = (id: string, overrides: Partial<StudioShot> = {}): StudioShot => ({
  id,
  title: id,
  fileIds: [],
  ...overrides,
});

const isVisual = (fileId: string) => fileId !== AUDIO;

describe('shot list edits', () => {
  it('adds, moves and removes shots', () => {
    const added = addShot([shot('one'), shot('two')]);
    expect(added).toHaveLength(3);
    expect(added[2].title).toBe('New shot');

    expect(moveShot(added, 'two', -1).map(item => item.id)).toEqual(['two', 'one', added[2].id]);
    expect(moveShot(added, 'one', -1)).toBe(added);
    expect(removeShot(added, 'one').map(item => item.id)).toEqual(['two', added[2].id]);
  });

  it('drops cleared prompts but keeps a title that is cleared', () => {
    const [edited] = updateShot([shot('one', { prompt: 'old', title: 'Hook' })], 'one', { prompt: '  ', title: ' ' });
    expect(edited).toEqual({ id: 'one', title: 'Hook', fileIds: [] });
  });

  it('chooses the first take added and falls back when the chosen take is removed', () => {
    let shots = addTakes([shot('one')], 'one', [FILE_A, FILE_B]);
    expect(shots[0]).toMatchObject({ fileIds: [FILE_A, FILE_B], chosenFileId: FILE_A });

    shots = addTakes(shots, 'one', [FILE_B, FILE_C]);
    expect(shots[0].fileIds).toEqual([FILE_A, FILE_B, FILE_C]);

    shots = chooseTake(shots, 'one', FILE_C);
    expect(shots[0].chosenFileId).toBe(FILE_C);
    expect(chooseTake(shots, 'one', FILE_D)[0].chosenFileId).toBe(FILE_C);

    shots = removeTake(shots, 'one', FILE_C);
    expect(shots[0]).toMatchObject({ fileIds: [FILE_A, FILE_B], chosenFileId: FILE_A });
    shots = removeTake(removeTake(shots, 'one', FILE_A), 'one', FILE_B);
    expect(shots[0]).not.toHaveProperty('chosenFileId');
  });
});

describe('clip handling on take changes', () => {
  const animated = shot('one', { fileIds: [FILE_A, FILE_B], chosenFileId: FILE_A, clipFileId: FILE_C });

  it('drops the clip when a different take is chosen and keeps it when the chosen take is unchanged', () => {
    expect(chooseTake([animated], 'one', FILE_B)[0]).not.toHaveProperty('clipFileId');
    expect(chooseTake([animated], 'one', FILE_B)[0].chosenFileId).toBe(FILE_B);
    expect(chooseTake([animated], 'one', FILE_A)[0].clipFileId).toBe(FILE_C);
  });

  it('drops the clip when the chosen take is removed and keeps it when another take is removed', () => {
    expect(removeTake([animated], 'one', FILE_A)[0]).not.toHaveProperty('clipFileId');
    expect(removeTake([animated], 'one', FILE_B)[0]).toMatchObject({ chosenFileId: FILE_A, clipFileId: FILE_C });
  });
});

describe('sendShotsToTimeline', () => {
  it('lays four chosen takes end to end across a 15s ad on the first video track', () => {
    const timeline = defaultStudioTimeline('ad_campaign');
    const shots = [FILE_A, FILE_B, FILE_C, FILE_D].map((fileId, index) =>
      shot(`s${index}`, { fileIds: [fileId], chosenFileId: fileId })
    );

    const sent = sendShotsToTimeline(timeline, shots, isVisual);
    const video = sent.tracks.find(track => track.kind === 'video');

    expect(video?.id).toBe(timeline.tracks[0].id);
    expect(video?.clips.map(clip => [clip.startMs, clip.durationMs])).toEqual([
      [0, 3750],
      [3750, 3750],
      [7500, 3750],
      [11250, 3750],
    ]);
    expect(validateStudioTimeline(sent)).toEqual([]);
    expect(sent.tracks).toHaveLength(timeline.tracks.length);
  });

  it('keeps a shot length, splits the rest, prefers clips and skips shots without a visual take', () => {
    const shots = [
      shot('fixed', { fileIds: [FILE_A], chosenFileId: FILE_A, durationMs: 5000 }),
      shot('empty'),
      shot('audio', { fileIds: [AUDIO], chosenFileId: AUDIO }),
      shot('flex', { fileIds: [FILE_B], chosenFileId: FILE_B, clipFileId: FILE_C }),
    ];
    const sent = sendShotsToTimeline(defaultStudioTimeline('ad_campaign'), shots, isVisual);
    const video = sent.tracks.find(track => track.kind === 'video');
    expect(video?.clips.map(clip => [clip.startMs, clip.durationMs])).toEqual([
      [0, 5000],
      [5000, 10_000],
    ]);
    // A shot's animated clip goes on the timeline in place of its chosen take.
    expect(video?.clips.map(clip => ('fileId' in clip ? clip.fileId : null))).toEqual([FILE_A, FILE_C]);
  });

  it('adds a video track when the timeline has none', () => {
    const timeline = { ...defaultStudioTimeline('ad_campaign'), tracks: [] };
    const sent = sendShotsToTimeline(timeline, [shot('one', { fileIds: [FILE_A], chosenFileId: FILE_A })], isVisual);
    expect(sent.tracks.map(track => track.kind)).toEqual(['video']);
  });

  it('refuses a board with nothing to send or shots longer than the production', () => {
    const timeline = defaultStudioTimeline('ad_campaign');
    expect(() => sendShotsToTimeline(timeline, [shot('one')], isVisual)).toThrow(/Pick an image or video/);
    expect(() =>
      sendShotsToTimeline(
        timeline,
        [shot('one', { fileIds: [FILE_A], chosenFileId: FILE_A, durationMs: 20_000 })],
        isVisual
      )
    ).toThrow(/longer than the production/);
  });
});
