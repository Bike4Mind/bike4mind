import {
  STUDIO_OUTPUT_ASPECT_RATIOS,
  type StudioOutputAspectRatio,
  type StudioTimeline,
  type StudioTimelineTrackKind,
} from './timeline';

export const STUDIO_TIMELINE_ISSUE_CODES = [
  'duplicate_id',
  'clip_overlap',
  'clip_out_of_bounds',
  'trim_out_of_bounds',
  'fade_too_long',
  'odd_output_edge',
  'aspect_ratio_mismatch',
  'unknown_file',
  'unsupported_file_kind',
  'unknown_sync_clip',
] as const;
export type StudioTimelineIssueCode = (typeof STUDIO_TIMELINE_ISSUE_CODES)[number];

/** `path` points into the timeline the way a Zod issue path does, so a form can attach it to the field at fault. */
export type StudioTimelineIssue = {
  code: StudioTimelineIssueCode;
  path: (string | number)[];
  message: string;
};

export const STUDIO_FILE_MEDIA_KINDS = ['video', 'image', 'audio', 'other'] as const;
export type StudioFileMediaKind = (typeof STUDIO_FILE_MEDIA_KINDS)[number];

/** The media kind of a file from its MIME type, the one signal a FabFile always carries. */
export const studioFileMediaKind = (mimeType: string): StudioFileMediaKind => {
  const [topLevel] = mimeType.toLowerCase().split('/');
  return topLevel === 'video' || topLevel === 'image' || topLevel === 'audio' ? topLevel : 'other';
};

/** Which file kinds each track plays; see the media rule in ./timeline. */
export const STUDIO_TRACK_FILE_KINDS: Record<Exclude<StudioTimelineTrackKind, 'captions'>, StudioFileMediaKind[]> = {
  video: ['video', 'image'],
  voice: ['audio', 'video'],
  sfx: ['audio', 'video'],
  music: ['audio', 'video'],
};

/**
 * What the caller knows about the referenced files. All are optional: the browser preview validates with nothing
 * known, the server with what it looked up. A file left out of `fileKinds` skips the kind check, and one left out
 * of `sourceDurationsMs` (an image, or not probed yet) skips the trim check.
 */
export type StudioTimelineReferenceContext = {
  knownFileIds?: ReadonlySet<string>;
  fileKinds?: ReadonlyMap<string, StudioFileMediaKind>;
  sourceDurationsMs?: ReadonlyMap<string, number>;
};

// Each pixel edge may round by up to one pixel when the even-edge rule is applied.
const ASPECT_RATIO_TOLERANCE_PX = 2;

const ASPECT_RATIO_PARTS: Record<StudioOutputAspectRatio, [number, number]> = Object.fromEntries(
  STUDIO_OUTPUT_ASPECT_RATIOS.map(ratio => [ratio, ratio.split(':').map(Number) as [number, number]])
) as Record<StudioOutputAspectRatio, [number, number]>;

const validateOutputs = (timeline: StudioTimeline): StudioTimelineIssue[] =>
  timeline.outputs.flatMap((output, index) => {
    const path = ['outputs', index];
    const issues: StudioTimelineIssue[] = [];
    // H.264 with yuv420p, the render job's target, rejects odd frame edges.
    if (output.width % 2 !== 0 || output.height % 2 !== 0) {
      issues.push({ code: 'odd_output_edge', path, message: `Output "${output.id}" needs even width and height` });
    }
    const [ratioWidth, ratioHeight] = ASPECT_RATIO_PARTS[output.aspectRatio];
    const expectedHeight = (output.width * ratioHeight) / ratioWidth;
    if (Math.abs(expectedHeight - output.height) > ASPECT_RATIO_TOLERANCE_PX) {
      issues.push({
        code: 'aspect_ratio_mismatch',
        path,
        message: `Output "${output.id}" is ${output.width}x${output.height}, not ${output.aspectRatio}`,
      });
    }
    return issues;
  });

const validateUniqueIds = (timeline: StudioTimeline): StudioTimelineIssue[] => {
  const seen = new Set<string>();
  const issues: StudioTimelineIssue[] = [];
  const check = (id: string, path: (string | number)[]) => {
    if (seen.has(id)) issues.push({ code: 'duplicate_id', path, message: `Id "${id}" is used more than once` });
    seen.add(id);
  };
  timeline.outputs.forEach((output, index) => check(output.id, ['outputs', index, 'id']));
  timeline.tracks.forEach((track, trackIndex) => {
    check(track.id, ['tracks', trackIndex, 'id']);
    track.clips.forEach((clip, clipIndex) => check(clip.id, ['tracks', trackIndex, 'clips', clipIndex, 'id']));
  });
  return issues;
};

const validateTrackLane = (timeline: StudioTimeline, trackIndex: number): StudioTimelineIssue[] => {
  const track = timeline.tracks[trackIndex];
  const issues: StudioTimelineIssue[] = [];
  const ordered = track.clips
    .map((clip, clipIndex) => ({ clip, clipIndex }))
    .sort((a, b) => a.clip.startMs - b.clip.startMs);

  // Compare each clip with the latest-ending clip before it, not just its neighbour, so a long clip that spans
  // several later ones flags every one of them.
  let latest: { id: string; endMs: number } | undefined;
  ordered.forEach(({ clip, clipIndex }) => {
    const path = ['tracks', trackIndex, 'clips', clipIndex];
    const endMs = clip.startMs + clip.durationMs;
    if (endMs > timeline.durationMs) {
      issues.push({
        code: 'clip_out_of_bounds',
        path,
        message: `Clip "${clip.id}" ends at ${endMs}ms, past the timeline's ${timeline.durationMs}ms`,
      });
    }
    // Back-to-back clips (end == next start) are fine; the interval is half-open.
    if (latest && clip.startMs < latest.endMs) {
      issues.push({
        code: 'clip_overlap',
        path,
        message: `Clip "${clip.id}" overlaps "${latest.id}" on track "${track.id}"`,
      });
    }
    if (!latest || endMs > latest.endMs) latest = { id: clip.id, endMs };
  });
  return issues;
};

const validateMediaClips = (timeline: StudioTimeline, context: StudioTimelineReferenceContext): StudioTimelineIssue[] =>
  timeline.tracks.flatMap((track, trackIndex) => {
    if (track.kind === 'captions') return [];
    return track.clips.flatMap((clip, clipIndex) => {
      const path = ['tracks', trackIndex, 'clips', clipIndex];
      const issues: StudioTimelineIssue[] = [];
      if (clip.fadeInMs + clip.fadeOutMs > clip.durationMs) {
        issues.push({ code: 'fade_too_long', path, message: `Clip "${clip.id}" fades are longer than the clip` });
      }
      if (context.knownFileIds && !context.knownFileIds.has(clip.fileId)) {
        issues.push({
          code: 'unknown_file',
          path: [...path, 'fileId'],
          message: `Clip "${clip.id}" references a file that is missing or not yours`,
        });
      }
      const fileKind = context.fileKinds?.get(clip.fileId);
      if (fileKind && !STUDIO_TRACK_FILE_KINDS[track.kind].includes(fileKind)) {
        issues.push({
          code: 'unsupported_file_kind',
          path: [...path, 'fileId'],
          message: `Clip "${clip.id}" is a ${fileKind} file, which a ${track.kind} track cannot play`,
        });
      }
      const sourceDurationMs = context.sourceDurationsMs?.get(clip.fileId);
      if (sourceDurationMs !== undefined && clip.trimStartMs + clip.durationMs > sourceDurationMs) {
        issues.push({
          code: 'trim_out_of_bounds',
          path,
          message: `Clip "${clip.id}" plays past the end of its ${sourceDurationMs}ms source`,
        });
      }
      return issues;
    });
  });

/**
 * A caption synced to a voice clip must name a clip on a voice track. The editor drops a link whose clip was
 * removed (shiftSyncedCaptions), so a dangling one means a writer outside the editor left it behind.
 */
const validateCaptionSync = (timeline: StudioTimeline): StudioTimelineIssue[] => {
  const voiceClipIds = new Set(
    timeline.tracks.flatMap(track => (track.kind === 'voice' ? track.clips.map(clip => clip.id) : []))
  );
  return timeline.tracks.flatMap((track, trackIndex) => {
    if (track.kind !== 'captions') return [];
    return track.clips.flatMap((clip, clipIndex): StudioTimelineIssue[] =>
      clip.syncedVoiceClipId === undefined || voiceClipIds.has(clip.syncedVoiceClipId)
        ? []
        : [
            {
              code: 'unknown_sync_clip',
              path: ['tracks', trackIndex, 'clips', clipIndex, 'syncedVoiceClipId'],
              message: `Caption "${clip.id}" is synced to "${clip.syncedVoiceClipId}", which is not a voice clip`,
            },
          ]
    );
  });
};

/**
 * The rules a schema-valid timeline must also meet before preview or render: unique ids, no overlap within a
 * track, every clip inside the timeline, fades inside their clip, renderable output sizes, and (given context)
 * known files of a kind the track plays and trims inside their source, and synced captions naming a voice clip. Returns every issue rather than the first, so an editor can mark
 * them all at once. Parse with StudioTimelineSchema first; this assumes a parsed timeline.
 */
export const validateStudioTimeline = (
  timeline: StudioTimeline,
  context: StudioTimelineReferenceContext = {}
): StudioTimelineIssue[] => [
  ...validateOutputs(timeline),
  ...validateUniqueIds(timeline),
  ...timeline.tracks.flatMap((_, trackIndex) => validateTrackLane(timeline, trackIndex)),
  ...validateMediaClips(timeline, context),
  ...validateCaptionSync(timeline),
];
