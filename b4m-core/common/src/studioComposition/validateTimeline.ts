import { STUDIO_OUTPUT_ASPECT_RATIOS, type StudioOutputAspectRatio, type StudioTimeline } from './timeline';

export const STUDIO_TIMELINE_ISSUE_CODES = [
  'duplicate_id',
  'clip_overlap',
  'clip_out_of_bounds',
  'trim_out_of_bounds',
  'fade_too_long',
  'odd_output_edge',
  'aspect_ratio_mismatch',
  'unknown_file',
] as const;
export type StudioTimelineIssueCode = (typeof STUDIO_TIMELINE_ISSUE_CODES)[number];

/** `path` points into the timeline the way a Zod issue path does, so a form can attach it to the field at fault. */
export type StudioTimelineIssue = {
  code: StudioTimelineIssueCode;
  path: (string | number)[];
  message: string;
};

/**
 * What the caller knows about the referenced files. Both are optional: the browser preview validates with nothing
 * known, the server with what it looked up. A file left out of `sourceDurationsMs` (an image, or not probed yet)
 * skips the trim check.
 */
export type StudioTimelineReferenceContext = {
  knownFileIds?: ReadonlySet<string>;
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

  ordered.forEach(({ clip, clipIndex }, position) => {
    const path = ['tracks', trackIndex, 'clips', clipIndex];
    const endMs = clip.startMs + clip.durationMs;
    if (endMs > timeline.durationMs) {
      issues.push({
        code: 'clip_out_of_bounds',
        path,
        message: `Clip "${clip.id}" ends at ${endMs}ms, past the timeline's ${timeline.durationMs}ms`,
      });
    }
    const next = ordered[position + 1];
    // Back-to-back clips (end == next start) are fine; the interval is half-open.
    if (next && next.clip.startMs < endMs) {
      issues.push({
        code: 'clip_overlap',
        path: ['tracks', trackIndex, 'clips', next.clipIndex],
        message: `Clip "${next.clip.id}" overlaps "${clip.id}" on track "${track.id}"`,
      });
    }
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
 * The rules a schema-valid timeline must also meet before preview or render: unique ids, no overlap within a
 * track, every clip inside the timeline, fades inside their clip, renderable output sizes, and (given context)
 * known files and trims inside their source. Returns every issue rather than the first, so an editor can mark
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
];
