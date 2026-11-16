import type { StudioCompositionContent } from './composition';
import {
  validateStudioTimeline,
  type StudioFileMediaKind,
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

type FileReference = { fileId: string; path: (string | number)[]; kinds?: readonly StudioFileMediaKind[] };

// Shot files are candidates of any media kind; the brand kit holds pictures (and product clips).
const LOGO_KINDS: readonly StudioFileMediaKind[] = ['image'];
const PRODUCT_KINDS: readonly StudioFileMediaKind[] = ['image', 'video'];

const validateFileReferences = (
  content: Pick<StudioCompositionContent, 'brandKit' | 'shots'>,
  { knownFileIds, fileKinds }: StudioTimelineReferenceContext
): StudioCompositionIssue[] => {
  const references: FileReference[] = [
    ...(content.brandKit.logoFileId
      ? [{ fileId: content.brandKit.logoFileId, path: ['brandKit', 'logoFileId'], kinds: LOGO_KINDS }]
      : []),
    ...content.brandKit.productFileIds.map((fileId, index) => ({
      fileId,
      path: ['brandKit', 'productFileIds', index],
      kinds: PRODUCT_KINDS,
    })),
    ...content.shots.flatMap((shot, shotIndex) =>
      shot.fileIds.map((fileId, index) => ({ fileId, path: ['shots', shotIndex, 'fileIds', index] }))
    ),
  ];
  return references.flatMap(({ fileId, path, kinds }): StudioCompositionIssue[] => {
    if (knownFileIds && !knownFileIds.has(fileId)) {
      return [{ code: 'unknown_file', path, message: 'References a file that is missing or not yours' }];
    }
    const kind = fileKinds?.get(fileId);
    if (kinds && kind && !kinds.includes(kind)) {
      return [{ code: 'unsupported_file_kind', path, message: `A ${kind} file cannot be used here` }];
    }
    return [];
  });
};

/**
 * Every rule a parsed composition must meet beyond its schema: the timeline rules (paths prefixed with
 * `timeline`), unique shot ids, and, given the context, that the brand kit and shots reference only known files of a
 * kind their slot accepts.
 */
export const validateStudioComposition = (
  content: Pick<StudioCompositionContent, 'brandKit' | 'shots' | 'timeline'>,
  context: StudioTimelineReferenceContext = {}
): StudioCompositionIssue[] => [
  ...validateStudioTimeline(content.timeline, context).map(issue => ({ ...issue, path: ['timeline', ...issue.path] })),
  ...validateShotIds(content),
  ...validateFileReferences(content, context),
];
