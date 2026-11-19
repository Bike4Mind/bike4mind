import type {
  StudioAudioClip,
  StudioCaptionClip,
  StudioShot,
  StudioTimeline,
  StudioTimelineTrack,
  StudioVideoClip,
} from '@bike4mind/common';

/** The tracks the director tools own; a track with any other id is the user's and is never touched. */
export const DIRECTOR_TRACK_IDS = {
  video: 'director-video',
  music: 'director-music',
  voice: 'director-voice',
  sfx: 'director-sfx',
  captions: 'director-captions',
} as const;
type DirectorTrackKind = keyof typeof DIRECTOR_TRACK_IDS;

// Draw order, bottom to top: the picture first, captions over everything.
const DIRECTOR_TRACK_ORDER: readonly DirectorTrackKind[] = ['video', 'music', 'voice', 'sfx', 'captions'];

export const DEFAULT_SHOT_DURATION_MS = 4000;
export const VOICE_LEAD_IN_MS = 200;
const MUSIC_FADE_IN_MS = 300;
const MUSIC_FADE_OUT_MS = 1000;
/** The bed sits under a voiceover; alone it plays at a fuller level. */
const MUSIC_VOLUME_UNDER_VOICE = 0.35;
const MUSIC_VOLUME_ALONE = 0.8;

export type ShotSlot = { shot: StudioShot; index: number; startMs: number; durationMs: number };

/** Shots end to end in storyboard order. */
export function layoutShots(shots: readonly StudioShot[]): { slots: ShotSlot[]; totalMs: number } {
  let cursor = 0;
  const slots = shots.map((shot, index) => {
    const durationMs = shot.durationMs ?? DEFAULT_SHOT_DURATION_MS;
    const slot = { shot, index, startMs: cursor, durationMs };
    cursor += durationMs;
    return slot;
  });
  return { slots, totalMs: cursor };
}

/** What a shot shows on the timeline: its animated clip, else its chosen still. */
export const shotPicture = (shot: StudioShot): string | undefined => shot.clipFileId ?? shot.chosenFileId;

export function buildVideoClips(slots: readonly ShotSlot[]): StudioVideoClip[] {
  return slots.flatMap(({ shot, startMs, durationMs }) => {
    const fileId = shotPicture(shot);
    if (!fileId) return [];
    // The music and voiceover carry the sound, so a generated clip's own audio is muted.
    return [
      {
        id: `${shot.id}-video`,
        startMs,
        durationMs,
        fileId,
        trimStartMs: 0,
        volume: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        fit: 'cover',
      },
    ];
  });
}

export function buildCaptionClips(slots: readonly ShotSlot[]): StudioCaptionClip[] {
  return slots.flatMap(({ shot, startMs, durationMs }) =>
    shot.voiceLine
      ? [
          {
            id: `${shot.id}-caption`,
            startMs,
            durationMs,
            text: shot.voiceLine,
            style: {
              position: 'bottom',
              align: 'center',
              fontSizePct: 5,
              maxWidthPct: 90,
              color: '#FFFFFF',
              backgroundColor: '#000000',
            },
          },
        ]
      : []
  );
}

export type PlacedAudio = { id: string; fileId: string; durationMs: number };

/**
 * One voice line per shot, each starting just after its shot does, so a line stays in sync with its shot's
 * caption. A line longer than the gap to the next line is cut where the next one starts, and a line past the end
 * is cut at the end; `makeVoiceover` reports each cut so the assistant can shorten the line.
 */
export function buildVoiceClips(
  lines: readonly (PlacedAudio & { slot: ShotSlot })[],
  timelineMs: number
): StudioAudioClip[] {
  const starts = lines.map(({ slot }) => slot.startMs + VOICE_LEAD_IN_MS);
  return lines.flatMap(({ id, fileId, durationMs }, index) => {
    const startMs = starts[index] as number;
    const nextStartMs = starts[index + 1] ?? timelineMs;
    const length = Math.min(durationMs, nextStartMs - startMs, timelineMs - startMs);
    if (length <= 0) return [];
    return [{ id, startMs, durationMs: length, fileId, trimStartMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0 }];
  });
}

export function buildMusicClip(music: PlacedAudio, timelineMs: number, underVoice: boolean): StudioAudioClip {
  const durationMs = Math.min(music.durationMs, timelineMs);
  const fadeOutMs = Math.min(MUSIC_FADE_OUT_MS, Math.floor(durationMs / 2));
  const fadeInMs = Math.min(MUSIC_FADE_IN_MS, durationMs - fadeOutMs);
  return {
    id: music.id,
    startMs: 0,
    durationMs,
    fileId: music.fileId,
    trimStartMs: 0,
    volume: underVoice ? MUSIC_VOLUME_UNDER_VOICE : MUSIC_VOLUME_ALONE,
    fadeInMs,
    fadeOutMs,
  };
}

/**
 * The director's music bed, trimmed to a re-timed cut. A song shorter than the new cut is kept as it is and ends
 * early under its fade; trimming only ever shortens a clip, so it never plays past its source.
 */
export function keptMusic(timeline: StudioTimeline, timelineMs: number): StudioAudioClip[] {
  const track = timeline.tracks.find(candidate => candidate.id === DIRECTOR_TRACK_IDS.music);
  if (track?.kind !== 'music') return [];
  return track.clips.flatMap(clip => {
    const durationMs = Math.min(clip.durationMs, timelineMs - clip.startMs);
    if (durationMs <= 0) return [];
    const fadeOutMs = Math.min(MUSIC_FADE_OUT_MS, Math.floor(durationMs / 2));
    return [{ ...clip, durationMs, fadeOutMs, fadeInMs: Math.min(clip.fadeInMs, durationMs - fadeOutMs) }];
  });
}

// A gap shorter than this under the end of the cut is lost in the bed's own fade-out.
const MUSIC_SHORT_TOLERANCE_MS = 500;

/**
 * How far the director's music bed ends short of `reachMs` (how much of the cut a new bed could cover), or 0 when it
 * is within tolerance (or there is none). keptMusic only shortens a bed, so a re-time that grows the cut leaves this
 * gap for production_add_audio to fill.
 */
export function musicShortfallMs(timeline: StudioTimeline, reachMs: number): number {
  const clips = directorClips(timeline, 'music');
  if (clips.length === 0) return 0;
  const gapMs = reachMs - Math.max(...clips.map(clip => clip.startMs + clip.durationMs));
  return gapMs > MUSIC_SHORT_TOLERANCE_MS ? gapMs : 0;
}

/**
 * Shots a re-timed storyboard leaves too short for their voice line: the line is unchanged, so its placed clip's
 * length still holds, and it has until the next spoken shot starts (buildVoiceClips cuts it there).
 */
export function shotsTooShortForVoice(
  timeline: StudioTimeline,
  previous: readonly StudioShot[],
  shots: readonly StudioShot[]
): { id: string; lineMs: number; roomMs: number }[] {
  const placed = new Map(directorClips(timeline, 'voice').map(clip => [clip.id, clip.durationMs]));
  return shots.flatMap((shot, index) => {
    const lineMs = placed.get(`${shot.id}-voice`);
    if (!shot.voiceLine || shot.voiceLine !== previous[index]?.voiceLine || lineMs === undefined) return [];
    const nextSpoken = shots.findIndex((candidate, at) => at > index && candidate.voiceLine);
    const spanMs = shots
      .slice(index, nextSpoken === -1 ? shots.length : nextSpoken)
      .reduce((sum, candidate) => sum + (candidate.durationMs ?? DEFAULT_SHOT_DURATION_MS), 0);
    const roomMs = nextSpoken === -1 ? spanMs - VOICE_LEAD_IN_MS : spanMs;
    return lineMs > roomMs ? [{ id: shot.id, lineMs, roomMs }] : [];
  });
}

/** One effect at the start of its shot, never longer than the shot, so effects on one track never overlap. */
export function buildSfxClips(effects: readonly (PlacedAudio & { slot: ShotSlot })[]): StudioAudioClip[] {
  return effects.map(({ id, fileId, durationMs, slot }) => ({
    id,
    startMs: slot.startMs,
    durationMs: Math.min(durationMs, slot.durationMs),
    fileId,
    trimStartMs: 0,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
  }));
}

const directorTrack = (kind: DirectorTrackKind, clips: StudioTimelineTrack['clips']): StudioTimelineTrack =>
  ({ id: DIRECTOR_TRACK_IDS[kind], kind, enabled: true, clips }) as StudioTimelineTrack;

export const directorClips = (timeline: StudioTimeline, kind: DirectorTrackKind): StudioTimelineTrack['clips'] =>
  timeline.tracks.find(track => track.id === DIRECTOR_TRACK_IDS[kind])?.clips ?? [];

/**
 * The timeline with the given director tracks replaced. The user's own tracks keep their place after the director's
 * picture track and are never changed; the timeline runs to the cut's `durationMs` or to the end of the user's last
 * clip, whichever is later. Director clips running past `durationMs` are cut there, and ones that would start at or
 * after it are dropped, so a shorter cut never leaves a director clip out of bounds. An empty director track is
 * dropped.
 */
export function withDirectorTracks(
  timeline: StudioTimeline,
  replacements: Partial<Record<DirectorTrackKind, StudioTimelineTrack['clips']>>,
  durationMs: number
): StudioTimeline {
  const directorIds = new Set<string>(Object.values(DIRECTOR_TRACK_IDS));
  const userTracks = timeline.tracks.filter(track => !directorIds.has(track.id));
  const director = Object.fromEntries(
    DIRECTOR_TRACK_ORDER.map(kind => [kind, replacements[kind] ?? directorClips(timeline, kind)])
  ) as Record<DirectorTrackKind, StudioTimelineTrack['clips']>;
  const build = (kind: DirectorTrackKind) =>
    ({ ...directorTrack(kind, director[kind]), clips: fitClips(director[kind], durationMs) }) as StudioTimelineTrack;
  const tracks = [
    build('video'),
    ...userTracks,
    ...DIRECTOR_TRACK_ORDER.filter(kind => kind !== 'video').map(build),
  ].filter(track => track.clips.length > 0 || !directorIds.has(track.id));
  const userEndMs = Math.max(
    0,
    ...userTracks.flatMap(track => track.clips.map(clip => clip.startMs + clip.durationMs))
  );
  return { ...timeline, durationMs: Math.max(durationMs, userEndMs), tracks };
}

function fitClips(clips: StudioTimelineTrack['clips'], durationMs: number): StudioTimelineTrack['clips'] {
  return clips.flatMap(clip => {
    if (clip.startMs >= durationMs) return [];
    const length = Math.min(clip.durationMs, durationMs - clip.startMs);
    if (length === clip.durationMs) return [clip];
    if (!('fadeInMs' in clip)) return [{ ...clip, durationMs: length }];
    // Fades are trimmed with the clip so their sum never exceeds its length.
    const fadeOutMs = Math.min(clip.fadeOutMs, Math.floor(length / 2));
    const fadeInMs = Math.min(clip.fadeInMs, length - fadeOutMs);
    return [{ ...clip, durationMs: length, fadeInMs, fadeOutMs }];
  }) as StudioTimelineTrack['clips'];
}
