import { describe, expect, it } from 'vitest';
import {
  StudioCompositionCreateInputSchema,
  defaultStudioTimeline,
  type StudioCompositionResponse,
} from '@bike4mind/common';
import { hookVariationBody } from './hookVariation';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);
const FILE_C = 'c'.repeat(24);

const timeline = defaultStudioTimeline('ad_campaign');
const source: StudioCompositionResponse = {
  id: 'f'.repeat(24),
  title: 'Spring ad',
  template: 'ad_campaign',
  brief: { summary: 'Cold brew, hot summer', productFileId: FILE_C },
  brandKit: { colors: ['#112233'], productFileIds: [] },
  shots: [
    {
      id: 'shot-1',
      title: 'Hook',
      intent: 'hook',
      prompt: 'A can on ice',
      fileIds: [FILE_A, FILE_B],
      chosenFileId: FILE_A,
    },
    { id: 'shot-2', title: 'Product', fileIds: [FILE_C], chosenFileId: FILE_C },
  ],
  timeline: {
    ...timeline,
    tracks: timeline.tracks.map(track =>
      track.kind === 'video'
        ? {
            ...track,
            clips: [
              {
                id: 'c1',
                fileId: FILE_A,
                startMs: 0,
                durationMs: 5000,
                trimStartMs: 0,
                volume: 1,
                fadeInMs: 0,
                fadeOutMs: 0,
                fit: 'cover' as const,
              },
              {
                id: 'c2',
                fileId: FILE_C,
                startMs: 5000,
                durationMs: 5000,
                trimStartMs: 0,
                volume: 1,
                fadeInMs: 0,
                fadeOutMs: 0,
                fit: 'cover' as const,
              },
            ],
          }
        : track
    ),
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('hookVariationBody', () => {
  it('swaps only the earliest clip of the old opener and drops a clip animated from the old take', () => {
    const withClip: StudioCompositionResponse = {
      ...source,
      shots: [{ ...source.shots[0], clipFileId: FILE_C }, source.shots[1]],
      timeline: {
        ...source.timeline,
        tracks: source.timeline.tracks.map(track =>
          track.kind === 'video' ? { ...track, clips: track.clips.map(clip => ({ ...clip, fileId: FILE_C })) } : track
        ),
      },
    };
    const body = hookVariationBody(withClip, { title: 'B', openingTakeFileId: FILE_B });

    expect(body.shots?.[0]).not.toHaveProperty('clipFileId');
    const videoFiles = body.timeline?.tracks.flatMap(track =>
      track.kind === 'video' ? track.clips.map(clip => clip.fileId) : []
    );
    expect(videoFiles).toEqual([FILE_B, FILE_C]);
  });

  it('resets the trim of the swapped clip', () => {
    const trimmed: StudioCompositionResponse = {
      ...source,
      timeline: {
        ...source.timeline,
        tracks: source.timeline.tracks.map(track =>
          track.kind === 'video'
            ? {
                ...track,
                clips: track.clips.map(clip => ({
                  ...clip,
                  trimStartMs: 1500,
                  crop: { '9:16': { x: 0.1, y: 0, width: 0.316406, height: 1 } },
                })),
              }
            : track
        ),
      },
    };
    const body = hookVariationBody(trimmed, { title: 'B', openingTakeFileId: FILE_B });
    const clips = body.timeline?.tracks.flatMap(track => (track.kind === 'video' ? track.clips : [])) ?? [];
    expect(clips.map(clip => [clip.fileId, clip.trimStartMs])).toEqual([
      [FILE_B, 0],
      [FILE_C, 1500],
    ]);
    // The new take may have another shape, so only the swapped clip loses its framing.
    expect(clips.map(clip => clip.crop !== undefined)).toEqual([false, true]);
  });

  it('copies the production with a new opening line, prompt and take, swapping the take on the timeline', () => {
    const body = hookVariationBody(source, {
      title: ' Spring ad - B ',
      openingLine: 'Too hot to think?',
      openingPrompt: 'Melting city street',
      openingTakeFileId: FILE_B,
    });

    expect(StudioCompositionCreateInputSchema.safeParse(body).success).toBe(true);
    expect(body.title).toBe('Spring ad - B');
    expect(body.brief).toEqual(source.brief);
    expect(body.shots?.[0]).toEqual({
      id: 'shot-1',
      title: 'Too hot to think?',
      intent: 'hook',
      prompt: 'Melting city street',
      fileIds: [FILE_A, FILE_B],
      chosenFileId: FILE_B,
    });
    expect(body.shots?.[1]).toEqual(source.shots[1]);
    const video = body.timeline?.tracks.find(track => track.kind === 'video');
    expect(video?.clips.map(clip => ('fileId' in clip ? clip.fileId : null))).toEqual([FILE_B, FILE_C]);
  });

  it('keeps the opener when nothing about it changes and ignores a take the shot does not have', () => {
    const body = hookVariationBody(source, { title: 'Copy', openingTakeFileId: 'd'.repeat(24) });
    expect(body.shots).toEqual(source.shots);
    expect(body.timeline).toBe(source.timeline);
  });

  it('drops a cleared prompt', () => {
    const body = hookVariationBody(source, { title: 'Copy', openingPrompt: '  ' });
    expect(body.shots?.[0]).not.toHaveProperty('prompt');
  });
});
