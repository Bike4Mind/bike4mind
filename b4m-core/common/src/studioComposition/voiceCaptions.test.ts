import { describe, expect, it } from 'vitest';
import type { SpeechWordTiming } from '../voiceGeneration';
import { StudioTimelineSchema, type StudioCaptionClip, type StudioTimeline } from './timeline';
import { validateStudioTimeline } from './validateTimeline';
import {
  buildVoiceCaptionCues,
  replaceVoiceCaptions,
  shiftSyncedCaptions,
  splitCaptionPhrases,
  voiceCaptionClips,
} from './voiceCaptions';

const FILE_A = 'a'.repeat(24);

/** Word timings as a provider would report them: each word `wordMs` long, `gapMs` apart, after `leadMs`. */
const timed = (
  script: string,
  { leadMs = 0, wordMs = 300, gapMs = 50, pauses = {} as Record<number, number> } = {}
) => {
  let cursor = leadMs;
  return script
    .split(/\s+/)
    .filter(Boolean)
    .map((text, index): SpeechWordTiming => {
      cursor += pauses[index] ?? 0;
      const word = { text, startMs: cursor, endMs: cursor + wordMs };
      cursor += wordMs + gapMs;
      return word;
    });
};

const counter = (prefix: string) => {
  let next = 0;
  return () => `${prefix}-${++next}`;
};

const timeline = (overrides: Partial<StudioTimeline> = {}): StudioTimeline =>
  StudioTimelineSchema.parse({
    version: 1,
    durationMs: 20_000,
    fps: 30,
    outputs: [{ id: 'out-16x9', aspectRatio: '16:9', width: 1920, height: 1080 }],
    tracks: [{ id: 'voice-1', kind: 'voice', clips: [{ id: 'vo1', fileId: FILE_A, startMs: 2000, durationMs: 8000 }] }],
    ...overrides,
  });

const captionsOf = (spec: StudioTimeline): StudioCaptionClip[] =>
  spec.tracks.flatMap(track => (track.kind === 'captions' ? track.clips : []));

describe('splitCaptionPhrases', () => {
  it('breaks at sentence ends and keeps phrases to a few words', () => {
    expect(splitCaptionPhrases('Ride further. Every morning we climb the hill before the city wakes!')).toEqual([
      'Ride further.',
      'Every morning we climb the hill',
      'before the city wakes!',
    ]);
  });

  it('keeps a sentence-final word with a full phrase instead of leaving it alone', () => {
    expect(splitCaptionPhrases('We all ride up the hill too. Then rest')).toEqual([
      'We all ride up the hill too.',
      'Then rest',
    ]);
    expect(splitCaptionPhrases('We all ride up the big hill and rest')).toEqual([
      'We all ride up the big',
      'hill and rest',
    ]);
  });

  it('breaks at a clause once the phrase has a few words, not on a lone word', () => {
    expect(splitCaptionPhrases('Yes, the new bike rides lighter, faster and quieter')).toEqual([
      'Yes, the new bike rides lighter,',
      'faster and quieter',
    ]);
  });

  it('breaks at a dash and an ellipsis', () => {
    expect(splitCaptionPhrases('We ride far\u2014 every day. Then\u2026 we rest')).toEqual([
      'We ride far\u2014',
      'every day.',
      'Then\u2026',
      'we rest',
    ]);
  });

  it('keeps each phrase within the character budget', () => {
    const phrases = splitCaptionPhrases('Extraordinarily comprehensive internationalization considerations matter');
    expect(phrases.every(phrase => phrase.length <= 32 || !phrase.includes(' '))).toBe(true);
  });

  it('returns nothing for a blank script', () => {
    expect(splitCaptionPhrases('  \n ')).toEqual([]);
  });
});

describe('splitCaptionPhrases without spaces', () => {
  // A Japanese script: two sentences with no spaces, joined by the CJK full stop and comma.
  const japanese =
    '\u4eca\u65e5\u306f\u3044\u3044\u5929\u6c17\u3067\u3059\u306d\u3001\u6563\u6b69\u306b\u884c\u304d\u307e\u3057\u3087\u3046\u3002'.repeat(
      4
    );

  it('cuts a long run of text without spaces into phrase-sized captions', () => {
    const phrases = splitCaptionPhrases(japanese);
    expect(phrases.length).toBeGreaterThan(1);
    for (const phrase of phrases) expect(Array.from(phrase).length).toBeLessThanOrEqual(32);
    expect(phrases.join('')).toBe(japanese);
  });

  it("shares an aligned token's time between its pieces", () => {
    const { cues, timing } = buildVoiceCaptionCues({
      script: japanese,
      wordTimings: [{ text: japanese, startMs: 0, endMs: 8000 }],
      audioDurationMs: 8000,
    });
    expect(timing).toBe('aligned');
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0].startMs).toBe(0);
    expect(cues.at(-1)?.endMs).toBeLessThanOrEqual(8000 + 400);
    for (let index = 1; index < cues.length; index++) {
      expect(cues[index].startMs).toBeGreaterThanOrEqual(cues[index - 1].endMs);
    }
  });
});

describe('buildVoiceCaptionCues', () => {
  it('times phrases from aligned words: start on the first word, hold briefly after the last', () => {
    const script = 'Ride further. Go faster today.';
    const { cues, timing } = buildVoiceCaptionCues({ script, wordTimings: timed(script), audioDurationMs: 5000 });
    expect(timing).toBe('aligned');
    // Words: Ride 0-300, further. 350-650, Go 700-1000, faster 1050-1350, today. 1400-1700.
    expect(cues).toEqual([
      { text: 'Ride further.', startMs: 0, endMs: 700 },
      { text: 'Go faster today.', startMs: 700, endMs: 2100 },
    ]);
  });

  it('starts a new phrase at a pause in the speech', () => {
    const script = 'one two three four';
    const { cues } = buildVoiceCaptionCues({
      script,
      wordTimings: timed(script, { pauses: { 2: 600 } }),
      audioDurationMs: 5000,
    });
    expect(cues.map(cue => cue.text)).toEqual(['one two', 'three four']);
    expect(cues[1].startMs).toBe(1300);
  });

  it('falls back to spreading phrases over the clip when there is no alignment', () => {
    const { cues, timing } = buildVoiceCaptionCues({ script: 'Ride further. Go!', audioDurationMs: 1700 });
    expect(timing).toBe('estimated');
    // 'Ride further.' is 13 characters and 'Go!' 3, so they share 1700ms 13:3.
    expect(cues).toEqual([
      { text: 'Ride further.', startMs: 0, endMs: 1381 },
      { text: 'Go!', startMs: 1381, endMs: 1700 },
    ]);
  });

  it('falls back when the alignment is of a different script', () => {
    const { timing } = buildVoiceCaptionCues({
      script: 'Ride further today',
      wordTimings: timed('Ride farther today'),
      audioDurationMs: 2000,
    });
    expect(timing).toBe('estimated');
  });

  it('yields no cues without words or without a duration to spread over', () => {
    expect(buildVoiceCaptionCues({ script: ' ', audioDurationMs: 1000 }).cues).toEqual([]);
    expect(buildVoiceCaptionCues({ script: 'Hello there', audioDurationMs: 0 }).cues).toEqual([]);
  });
});

describe('voiceCaptionClips', () => {
  const cues = [
    { text: 'first', startMs: 0, endMs: 1000 },
    { text: 'second', startMs: 1000, endMs: 2000 },
    { text: 'third', startMs: 2000, endMs: 3000 },
  ];

  it('places cues relative to the clip start and links them when synced', () => {
    const clips = voiceCaptionClips({
      voiceClip: { id: 'vo1', startMs: 2000, durationMs: 8000, trimStartMs: 0 },
      cues,
      timelineDurationMs: 20_000,
      mintId: counter('cap'),
      sync: true,
    });
    expect(clips.map(({ startMs, durationMs, text }) => ({ startMs, durationMs, text }))).toEqual([
      { startMs: 2000, durationMs: 1000, text: 'first' },
      { startMs: 3000, durationMs: 1000, text: 'second' },
      { startMs: 4000, durationMs: 1000, text: 'third' },
    ]);
    expect(clips.every(clip => clip.syncedVoiceClipId === 'vo1')).toBe(true);
    expect(clips[0].style).toMatchObject({ position: 'bottom', align: 'center' });
  });

  it('captions only what a trimmed clip plays', () => {
    const clips = voiceCaptionClips({
      // Plays source 1500-2500 at timeline 2000-3000.
      voiceClip: { id: 'vo1', startMs: 2000, durationMs: 1000, trimStartMs: 1500 },
      cues,
      timelineDurationMs: 20_000,
      mintId: counter('cap'),
      sync: false,
    });
    expect(clips.map(({ startMs, durationMs, text }) => ({ startMs, durationMs, text }))).toEqual([
      { startMs: 2000, durationMs: 500, text: 'second' },
      { startMs: 2500, durationMs: 500, text: 'third' },
    ]);
    expect(clips[0]).not.toHaveProperty('syncedVoiceClipId');
  });
});

describe('replaceVoiceCaptions', () => {
  const place = (spec: StudioTimeline, mintId = counter('cap')) =>
    voiceCaptionClips({
      voiceClip: { id: 'vo1', startMs: 2000, durationMs: 8000, trimStartMs: 0 },
      cues: buildVoiceCaptionCues({ script: 'Ride further. Go faster today.', audioDurationMs: 4000 }).cues,
      timelineDurationMs: spec.durationMs,
      mintId,
      sync: true,
    });

  it('adds a captions track and yields a valid timeline', () => {
    const spec = timeline();
    const next = replaceVoiceCaptions(spec, 'vo1', place(spec), () => 'captions-1');
    expect(next.tracks.at(-1)).toMatchObject({ id: 'captions-1', kind: 'captions' });
    expect(captionsOf(next)).toHaveLength(2);
    expect(validateStudioTimeline(StudioTimelineSchema.parse(next), {})).toEqual([]);
  });

  it('replaces the captions previously synced to the clip and keeps other captions', () => {
    const spec = timeline();
    const handMade = { id: 'hand', text: 'Intro', startMs: 0, durationMs: 1500, style: place(spec)[0].style };
    const first = replaceVoiceCaptions(spec, 'vo1', place(spec, counter('old')), () => 'captions-1');
    const withHandMade = {
      ...first,
      tracks: first.tracks.map(track =>
        track.kind === 'captions' ? { ...track, clips: [handMade, ...track.clips] } : track
      ),
    } as StudioTimeline;
    const second = replaceVoiceCaptions(withHandMade, 'vo1', place(spec, counter('new')), () => 'unused');
    expect(captionsOf(second).map(clip => clip.id)).toEqual(['hand', 'new-1', 'new-2']);
  });

  it('skips a hidden captions track and adds a visible one', () => {
    const spec = timeline({
      tracks: [...timeline().tracks, { id: 'hidden', kind: 'captions', enabled: false, clips: [] }],
    } as Partial<StudioTimeline>);
    const next = replaceVoiceCaptions(spec, 'vo1', place(spec), () => 'captions-1');
    expect(next.tracks.find(track => track.id === 'hidden')?.clips).toEqual([]);
    expect(next.tracks.at(-1)).toMatchObject({ id: 'captions-1', enabled: true });
    expect(captionsOf(next)).toHaveLength(2);
  });

  it('refuses to put the track over its clip limit', () => {
    const spec = timeline({ durationMs: 600_000 });
    const style = place(spec)[0].style;
    const full = Array.from({ length: 499 }, (_, index) => ({
      id: `hand-${index}`,
      text: 'x',
      startMs: 20_000 + index * 1000,
      durationMs: 500,
      style,
    }));
    const crowded = replaceVoiceCaptions(spec, 'none', full, () => 'captions-1');
    expect(() => replaceVoiceCaptions(crowded, 'vo1', place(spec), () => 'unused')).toThrow(/limit of 500/);
  });

  it('refuses to land on a caption that is not synced to the clip', () => {
    const spec = timeline();
    const placed = place(spec);
    const blocking = { ...placed[0], id: 'hand', syncedVoiceClipId: undefined };
    const withBlocking = replaceVoiceCaptions(spec, 'other', [blocking], () => 'captions-1');
    expect(() => replaceVoiceCaptions(withBlocking, 'vo1', placed, () => 'unused')).toThrow(/overlap/);
  });
});

describe('shiftSyncedCaptions', () => {
  const withCaptions = (spec: StudioTimeline) => {
    const placed = voiceCaptionClips({
      voiceClip: { id: 'vo1', startMs: 2000, durationMs: 8000, trimStartMs: 0 },
      cues: [{ text: 'hello', startMs: 500, endMs: 1500 }],
      timelineDurationMs: spec.durationMs,
      mintId: () => 'cap-1',
      sync: true,
    });
    const free = { ...placed[0], id: 'cap-free', startMs: 15_000, syncedVoiceClipId: undefined };
    return replaceVoiceCaptions(
      replaceVoiceCaptions(spec, 'none', [free], () => 'captions-1'),
      'vo1',
      placed,
      () => ''
    );
  };

  const moveVoice = (spec: StudioTimeline, patch: { startMs?: number; trimStartMs?: number }) =>
    ({
      ...spec,
      tracks: spec.tracks.map(track =>
        track.kind === 'voice' ? { ...track, clips: track.clips.map(clip => ({ ...clip, ...patch })) } : track
      ),
    }) as StudioTimeline;

  it('moves synced captions with their voice clip and leaves the others', () => {
    const before = withCaptions(timeline());
    const after = shiftSyncedCaptions(before, moveVoice(before, { startMs: 3000 }));
    const byId = Object.fromEntries(captionsOf(after).map(clip => [clip.id, clip.startMs]));
    expect(byId).toEqual({ 'cap-1': 3500, 'cap-free': 15_000 });
  });

  it('follows a slip trim that moves the audio under the clip', () => {
    const before = withCaptions(timeline());
    // Trimming 400ms off the start of the source while the clip stays put pulls the audio 400ms earlier.
    const after = shiftSyncedCaptions(before, moveVoice(before, { trimStartMs: 400 }));
    expect(captionsOf(after).find(clip => clip.id === 'cap-1')?.startMs).toBe(2100);
  });

  it('cuts captions pushed off the start instead of stacking them there', () => {
    const spec = timeline({
      tracks: [
        { id: 'voice-1', kind: 'voice', clips: [{ id: 'vo1', fileId: FILE_A, startMs: 500, durationMs: 4000 }] },
      ],
    } as Partial<StudioTimeline>);
    const placed = voiceCaptionClips({
      voiceClip: { id: 'vo1', startMs: 500, durationMs: 4000, trimStartMs: 0 },
      cues: [
        { text: 'one', startMs: 100, endMs: 500 },
        { text: 'two', startMs: 500, endMs: 1100 },
      ],
      timelineDurationMs: spec.durationMs,
      mintId: counter('cap'),
      sync: true,
    });
    const before = replaceVoiceCaptions(spec, 'vo1', placed, () => 'captions-1');
    // Trimming 1000ms off the source pulls the audio 1000ms earlier: "one" falls off the start, "two" is cut.
    const after = shiftSyncedCaptions(before, moveVoice(before, { trimStartMs: 1000 }));
    expect(captionsOf(after).map(({ id, startMs, durationMs }) => ({ id, startMs, durationMs }))).toEqual([
      { id: 'cap-2', startMs: 0, durationMs: 600 },
    ]);
    expect(validateStudioTimeline(StudioTimelineSchema.parse(after), {})).toEqual([]);
  });

  it('cuts captions pushed past the end of the timeline', () => {
    const before = withCaptions(timeline());
    // cap-1 sits 500ms into the audio for 1000ms; the voice moves so it would start 300ms before the end.
    const after = shiftSyncedCaptions(before, moveVoice(before, { startMs: 19_200 }));
    expect(captionsOf(after).find(clip => clip.id === 'cap-1')).toMatchObject({ startMs: 19_700, durationMs: 300 });
  });

  it('returns the same timeline when no voice audio moved', () => {
    const before = withCaptions(timeline());
    const next = { ...before };
    expect(shiftSyncedCaptions(before, next)).toBe(next);
  });

  it('unlinks captions whose voice clip was removed', () => {
    const before = withCaptions(timeline());
    const removed = {
      ...before,
      tracks: before.tracks.map(track => (track.kind === 'voice' ? { ...track, clips: [] } : track)),
    } as StudioTimeline;
    const caption = captionsOf(shiftSyncedCaptions(before, removed)).find(clip => clip.id === 'cap-1');
    expect(caption?.startMs).toBe(2500);
    expect(caption).not.toHaveProperty('syncedVoiceClipId');
  });
});

describe('validateStudioTimeline caption sync', () => {
  const withSync = (syncedVoiceClipId: string) =>
    timeline({
      tracks: [
        ...timeline().tracks,
        {
          id: 'captions-1',
          kind: 'captions',
          enabled: true,
          clips: [{ id: 'c1', text: 'Hi', startMs: 2000, durationMs: 500, syncedVoiceClipId }],
        },
        // Parsed by timeline(), which fills the caption style.
      ] as unknown as StudioTimeline['tracks'],
    });

  it('accepts a caption synced to a voice clip', () => {
    expect(validateStudioTimeline(withSync('vo1'))).toEqual([]);
  });

  it('flags a caption synced to a clip that is not on a voice track', () => {
    expect(validateStudioTimeline(withSync('gone'))).toEqual([
      expect.objectContaining({ code: 'unknown_sync_clip', path: ['tracks', 1, 'clips', 0, 'syncedVoiceClipId'] }),
    ]);
  });

  it('is clean once the editor has unlinked a caption from its removed voice clip', () => {
    const synced = withSync('vo1');
    const removed = {
      ...synced,
      tracks: synced.tracks.map(track => (track.kind === 'voice' ? { ...track, clips: [] } : track)),
    } as StudioTimeline;
    expect(validateStudioTimeline(removed).map(issue => issue.code)).toEqual(['unknown_sync_clip']);
    expect(validateStudioTimeline(shiftSyncedCaptions(synced, removed))).toEqual([]);
  });
});
