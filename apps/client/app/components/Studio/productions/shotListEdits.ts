import {
  STUDIO_COMPOSITION_LIMITS,
  type StudioShot,
  type StudioTimeline,
  type StudioTimelineTrack,
  type StudioVideoClip,
  randomUuid,
} from '@bike4mind/common';
import { MIN_CLIP_MS, mintTimelineId } from './timelineEdits';

/**
 * Pure edits on a production's shot list. A shot's `fileIds` holds every take, the chosen one included; the
 * alternatives are the rest. Each edit returns a new list and never validates: the server runs the shared rules.
 */

export type StudioShotPatch = Partial<Pick<StudioShot, 'title' | 'prompt' | 'intent' | 'voiceLine'>>;

/** What a shot puts on the timeline: its animated clip when it has one, else its chosen take. */
export const shotTimelineFileId = (shot: StudioShot): string | undefined => shot.clipFileId ?? shot.chosenFileId;

const NEW_SHOT_TITLE = 'New shot';

export const mintShotId = (): string => `shot-${randomUuid()}`;

export const addShot = (shots: StudioShot[]): StudioShot[] => {
  if (shots.length >= STUDIO_COMPOSITION_LIMITS.shotsMax) {
    throw new Error(`A production holds at most ${STUDIO_COMPOSITION_LIMITS.shotsMax} shots.`);
  }
  return [...shots, { id: mintShotId(), title: NEW_SHOT_TITLE, fileIds: [] }];
};

export const removeShot = (shots: StudioShot[], shotId: string): StudioShot[] =>
  shots.filter(shot => shot.id !== shotId);

/** Moves a shot one place earlier (-1) or later (1); a move past either end leaves the list as it is. */
export const moveShot = (shots: StudioShot[], shotId: string, offset: -1 | 1): StudioShot[] => {
  const from = shots.findIndex(shot => shot.id === shotId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= shots.length) return shots;
  const next = [...shots];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
};

const mapShot = (shots: StudioShot[], shotId: string, edit: (shot: StudioShot) => StudioShot): StudioShot[] =>
  shots.map(shot => (shot.id === shotId ? edit(shot) : shot));

/** Empty text fields are dropped rather than stored as "". A cleared title keeps the old one: titles are required. */
export const updateShot = (shots: StudioShot[], shotId: string, patch: StudioShotPatch): StudioShot[] =>
  mapShot(shots, shotId, shot => {
    const next: StudioShot = { ...shot };
    if (patch.title !== undefined && patch.title.trim()) next.title = patch.title.trim();
    for (const key of ['prompt', 'intent', 'voiceLine'] as const) {
      if (patch[key] === undefined) continue;
      const value = patch[key].trim();
      if (value) next[key] = value;
      else delete next[key];
    }
    return next;
  });

/** Adds takes the shot does not have yet, and chooses the first one when nothing is chosen. */
export const addTakes = (shots: StudioShot[], shotId: string, fileIds: string[]): StudioShot[] =>
  mapShot(shots, shotId, shot => {
    const added = fileIds.filter(fileId => !shot.fileIds.includes(fileId));
    const takes = [...shot.fileIds, ...added];
    if (takes.length > STUDIO_COMPOSITION_LIMITS.shotFilesMax) {
      throw new Error(`A shot holds at most ${STUDIO_COMPOSITION_LIMITS.shotFilesMax} takes.`);
    }
    return { ...shot, fileIds: takes, chosenFileId: shot.chosenFileId ?? takes[0] };
  });

/** The clip was animated from the previous chosen take, so a different choice drops it. */
const withChosenTake = (shot: StudioShot, chosenFileId: string | undefined): StudioShot => {
  const { chosenFileId: previous, clipFileId, ...rest } = shot;
  const keepClip = clipFileId !== undefined && chosenFileId === previous;
  return { ...rest, ...(chosenFileId && { chosenFileId }), ...(keepClip && { clipFileId }) };
};

export const chooseTake = (shots: StudioShot[], shotId: string, fileId: string): StudioShot[] =>
  mapShot(shots, shotId, shot => (shot.fileIds.includes(fileId) ? withChosenTake(shot, fileId) : shot));

/** Removing the chosen take falls back to the next remaining one. */
export const removeTake = (shots: StudioShot[], shotId: string, fileId: string): StudioShot[] =>
  mapShot(shots, shotId, shot => {
    const takes = shot.fileIds.filter(id => id !== fileId);
    const chosenFileId = shot.chosenFileId === fileId ? takes[0] : shot.chosenFileId;
    return { ...withChosenTake(shot, chosenFileId), fileIds: takes };
  });

/** A take that can sit on a video track: an image or a video (an audio take has no picture). */
export type IsVisualTake = (fileId: string) => boolean;

const videoClip = (fileId: string, startMs: number, durationMs: number): StudioVideoClip => ({
  id: mintTimelineId('clip'),
  fileId,
  startMs,
  durationMs,
  trimStartMs: 0,
  volume: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  fit: 'cover',
});

/**
 * Lays every shot's clip or chosen take end to end on the first video track, replacing what that track held. A shot with its
 * own `durationMs` keeps it; the others share the remaining length equally, so a 4-shot board fills a 15s ad.
 * Shots without a visual chosen take are skipped. Throws when nothing can be sent or the shots overrun the length.
 */
export const sendShotsToTimeline = (
  timeline: StudioTimeline,
  shots: StudioShot[],
  isVisual: IsVisualTake
): StudioTimeline => {
  const sendable = shots.flatMap(shot => {
    const fileId = shotTimelineFileId(shot);
    return fileId && isVisual(fileId) ? [{ fileId, durationMs: shot.durationMs }] : [];
  });
  if (sendable.length === 0) throw new Error('Pick an image or video take for at least one shot first.');

  const fixedMs = sendable.reduce((total, shot) => total + (shot.durationMs ?? 0), 0);
  const flexibleCount = sendable.filter(shot => shot.durationMs === undefined).length;
  const shareMs = flexibleCount > 0 ? Math.floor((timeline.durationMs - fixedMs) / flexibleCount) : 0;
  if (fixedMs > timeline.durationMs || (flexibleCount > 0 && shareMs < MIN_CLIP_MS)) {
    throw new Error('The shots are longer than the production. Make it longer or shorten a shot first.');
  }

  let startMs = 0;
  const clips = sendable.map(shot => {
    const durationMs = shot.durationMs ?? shareMs;
    const clip = videoClip(shot.fileId, startMs, durationMs);
    startMs += durationMs;
    return clip;
  });

  const existing = timeline.tracks.find(track => track.kind === 'video');
  const track: StudioTimelineTrack = existing
    ? { ...existing, clips }
    : { id: mintTimelineId('track'), kind: 'video', enabled: true, clips };
  return {
    ...timeline,
    tracks: existing
      ? timeline.tracks.map(candidate => (candidate.id === existing.id ? track : candidate))
      : [track, ...timeline.tracks],
  };
};
