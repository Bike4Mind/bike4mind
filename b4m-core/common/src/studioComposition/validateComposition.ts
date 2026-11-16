import type { StudioCompositionContent } from './composition';
import {
  validateStudioTimeline,
  type StudioTimelineIssue,
  type StudioTimelineReferenceContext,
} from './validateTimeline';

export type StudioCompositionIssue = StudioTimelineIssue;

const validateShotIds = (content: Pick<StudioCompositionContent, 'shots'>): StudioCompositionIssue[] => {
  const seen = new Set<string>();
  return content.shots.flatMap((shot, index) => {
    const duplicate = seen.has(shot.id);
    seen.add(shot.id);
    return duplicate
      ? [
          {
            code: 'duplicate_id' as const,
            path: ['shots', index, 'id'],
            message: `Shot id "${shot.id}" is used more than once`,
          },
        ]
      : [];
  });
};

const validateFileReferences = (
  content: Pick<StudioCompositionContent, 'brandKit' | 'shots'>,
  knownFileIds: ReadonlySet<string>
): StudioCompositionIssue[] => {
  const references: { fileId: string; path: (string | number)[] }[] = [
    ...(content.brandKit.logoFileId ? [{ fileId: content.brandKit.logoFileId, path: ['brandKit', 'logoFileId'] }] : []),
    ...content.brandKit.productFileIds.map((fileId, index) => ({
      fileId,
      path: ['brandKit', 'productFileIds', index],
    })),
    ...content.shots.flatMap((shot, shotIndex) =>
      shot.fileIds.map((fileId, index) => ({ fileId, path: ['shots', shotIndex, 'fileIds', index] }))
    ),
  ];
  return references
    .filter(reference => !knownFileIds.has(reference.fileId))
    .map(({ path }) => ({
      code: 'unknown_file' as const,
      path,
      message: 'References a file that is missing or not yours',
    }));
};

/**
 * Every rule a parsed composition must meet beyond its schema: the timeline rules (paths prefixed with
 * `timeline`), unique shot ids, and, given `knownFileIds`, that the brand kit and shots reference only known files.
 */
export const validateStudioComposition = (
  content: Pick<StudioCompositionContent, 'brandKit' | 'shots' | 'timeline'>,
  context: StudioTimelineReferenceContext = {}
): StudioCompositionIssue[] => [
  ...validateStudioTimeline(content.timeline, context).map(issue => ({ ...issue, path: ['timeline', ...issue.path] })),
  ...validateShotIds(content),
  ...(context.knownFileIds ? validateFileReferences(content, context.knownFileIds) : []),
];
