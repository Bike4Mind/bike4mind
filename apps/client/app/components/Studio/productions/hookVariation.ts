import type {
  StudioCompositionCreateBody,
  StudioCompositionResponse,
  StudioShot,
  StudioTimeline,
} from '@bike4mind/common';

/** What changes in a hook variation: the copy's title and its opening shot's line, prompt and chosen take. */
export type HookVariationChanges = {
  title: string;
  openingLine?: string;
  openingPrompt?: string;
  openingTakeFileId?: string;
};

const swapVideoFile = (timeline: StudioTimeline, fromFileId: string, toFileId: string): StudioTimeline => ({
  ...timeline,
  tracks: timeline.tracks.map(track =>
    track.kind === 'video'
      ? { ...track, clips: track.clips.map(clip => (clip.fileId === fromFileId ? { ...clip, fileId: toFileId } : clip)) }
      : track
  ),
});

const withNewOpener = (opening: StudioShot, changes: HookVariationChanges): StudioShot => {
  const { prompt: _previousPrompt, chosenFileId: _previousTake, ...base } = opening;
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
  };
};

/**
 * The create body for a copy of a production with a different opener. A new opening take also replaces the old one
 * wherever it sits on a video track, so the copy's cut opens on it without re-sending the board.
 */
export const hookVariationBody = (
  source: StudioCompositionResponse,
  changes: HookVariationChanges
): StudioCompositionCreateBody => {
  const [opening, ...rest] = source.shots;
  const opener = opening ? withNewOpener(opening, changes) : undefined;
  const swapped =
    opening?.chosenFileId && opener?.chosenFileId && opener.chosenFileId !== opening.chosenFileId
      ? swapVideoFile(source.timeline, opening.chosenFileId, opener.chosenFileId)
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
