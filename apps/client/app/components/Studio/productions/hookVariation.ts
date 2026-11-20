import type {
  StudioCompositionCreateBody,
  StudioCompositionResponse,
  StudioShot,
  StudioTimeline,
  StudioVideoClip,
} from '@bike4mind/common';
import { shotTimelineFileId } from './shotListEdits';

/** What changes in a hook variation: the copy's title and its opening shot's line, prompt and chosen take. */
export type HookVariationChanges = {
  title: string;
  openingLine?: string;
  openingPrompt?: string;
  openingTakeFileId?: string;
};

// Only the earliest video clip showing the old opener is swapped: the same file reused later in the cut stays.
const swapOpeningVideoFile = (timeline: StudioTimeline, fromFileId: string, toFileId: string): StudioTimeline => {
  const opening = timeline.tracks
    .flatMap(track => (track.kind === 'video' ? track.clips : []))
    .filter(clip => clip.fileId === fromFileId)
    .sort((left, right) => left.startMs - right.startMs)[0];
  if (!opening) return timeline;
  return {
    ...timeline,
    tracks: timeline.tracks.map(track =>
      track.kind === 'video'
        ? {
            ...track,
            clips: track.clips.map(clip => (clip === opening ? swapClipFile(clip, toFileId) : clip)),
          }
        : track
    ),
  };
};

const withNewOpener = (opening: StudioShot, changes: HookVariationChanges): StudioShot => {
  const { prompt: _previousPrompt, chosenFileId: _previousTake, clipFileId, ...base } = opening;
  const prompt = (changes.openingPrompt ?? opening.prompt ?? '').trim();
  const take =
    changes.openingTakeFileId && opening.fileIds.includes(changes.openingTakeFileId)
      ? changes.openingTakeFileId
      : opening.chosenFileId;
  return {
    ...base,
    title: changes.openingLine?.trim() || opening.title,
    ...(prompt && { prompt }),
    ...(take && { chosenFileId: take }),
    // The clip was animated from the old take, so a new take drops it.
    ...(clipFileId && take === opening.chosenFileId && { clipFileId }),
  };
};

/**
 * The create body for a copy of a production with a different opener. A new opening take also replaces the old
 * opener (its take, or its clip) in the earliest video clip showing it, so the copy's cut opens on it without
 * re-sending the board.
 */
export const hookVariationBody = (
  source: StudioCompositionResponse,
  changes: HookVariationChanges
): StudioCompositionCreateBody => {
  const [opening, ...rest] = source.shots;
  const opener = opening ? withNewOpener(opening, changes) : undefined;
  const previousFileId = opening && shotTimelineFileId(opening);
  const nextFileId = opener && shotTimelineFileId(opener);
  const swapped =
    previousFileId && nextFileId && previousFileId !== nextFileId
      ? swapOpeningVideoFile(source.timeline, previousFileId, nextFileId)
      : source.timeline;

  return {
    title: changes.title.trim(),
    template: source.template,
    brief: source.brief,
    brandKit: source.brandKit,
    shots: opener ? [opener, ...rest] : [],
    timeline: swapped,
    ...(source.projectId && { projectId: source.projectId }),
  };
};

/** A new take may have another shape, so the old take's framing (crop rects) does not carry over. */
const swapClipFile = (clip: StudioVideoClip, fileId: string): StudioVideoClip => {
  const { crop: _previousFraming, ...rest } = clip;
  return { ...rest, fileId, trimStartMs: 0 };
};
