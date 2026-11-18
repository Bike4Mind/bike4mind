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
const VOICE_LEAD_IN_MS = 200;
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
 * One voice line per shot, each starting just after its shot does. A line longer than its shot runs on into the
 * next, so the following line waits for it rather than overlapping; a line past the end is cut at the end.
 */
export function buildVoiceClips(
  lines: readonly (PlacedAudio & { slot: ShotSlot })[],
  timelineMs: number
): StudioAudioClip[] {
  let previousEnd = 0;
  return lines.flatMap(({ id, fileId, durationMs, slot }) => {
    const startMs = Math.max(slot.startMs + VOICE_LEAD_IN_MS, previousEnd);
    const length = Math.min(durationMs, timelineMs - startMs);
    if (length <= 0) return [];
    previousEnd = startMs + length;
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
 * dropped, and so is an empty lane of a kind the director lays (a template's starter lane).
 */
export function withDirectorTracks(
  timeline: StudioTimeline,
  replacements: Partial<Record<DirectorTrackKind, StudioTimelineTrack['clips']>>,
  durationMs: number
): StudioTimeline {
  const directorIds = new Set<string>(Object.values(DIRECTOR_TRACK_IDS));
  const director = Object.fromEntries(
    DIRECTOR_TRACK_ORDER.map(kind => [kind, replacements[kind] ?? directorClips(timeline, kind)])
  ) as Record<DirectorTrackKind, StudioTimelineTrack['clips']>;
  // defaultStudioTimeline seeds an empty lane per template kind.
  const laid = (kind: string) => kind in director && director[kind as DirectorTrackKind].length > 0;
  const userTracks = timeline.tracks.filter(
    track => !directorIds.has(track.id) && !(track.clips.length === 0 && laid(track.kind))
  );
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
