import type { StudioCompositionContent, StudioCompositionReferences } from './composition';
import {
  validateStudioTimeline,
  type StudioFileMediaKind,
  type StudioTimelineIssue,
  type StudioTimelineReferenceContext,
} from './validateTimeline';

export type StudioCompositionIssue = Omit<StudioTimelineIssue, 'code'> & {
  code: StudioTimelineIssue['code'] | 'unknown_take';
};

const duplicateIds = (
  items: readonly { id: string }[],
  path: (string | number)[],
  noun: string
): StudioCompositionIssue[] => {
  const seen = new Set<string>();
  return items.flatMap((item, index) => {
    const duplicate = seen.has(item.id);
    seen.add(item.id);
    return duplicate
      ? [
          {
            code: 'duplicate_id' as const,
            path: [...path, index, 'id'],
            message: `${noun} id "${item.id}" is used more than once`,
          },
        ]
      : [];
  });
};

type FileReference = { fileId: string; path: (string | number)[]; kinds?: readonly StudioFileMediaKind[] };

// Shot files are candidates of any media kind; the brief and brand kit hold pictures (and product clips).
const PRODUCT_PHOTO_KINDS: readonly StudioFileMediaKind[] = ['image'];
const CLIP_KINDS: readonly StudioFileMediaKind[] = ['video'];
const LOGO_KINDS: readonly StudioFileMediaKind[] = ['image'];
const PRODUCT_KINDS: readonly StudioFileMediaKind[] = ['image', 'video'];
const CHARACTER_KINDS: readonly StudioFileMediaKind[] = ['image'];

const validateChosenTakes = (content: Pick<StudioCompositionContent, 'shots'>): StudioCompositionIssue[] =>
  content.shots.flatMap((shot, index): StudioCompositionIssue[] =>
    shot.chosenFileId && !shot.fileIds.includes(shot.chosenFileId)
      ? [
          {
            code: 'unknown_take',
            path: ['shots', index, 'chosenFileId'],
            message: `The chosen take of shot "${shot.title}" is not one of its takes`,
          },
        ]
      : []
  );

const validateFileReferences = (
  content: Pick<StudioCompositionContent, 'brief' | 'brandKit' | 'shots'>,
  { knownFileIds, fileKinds }: StudioTimelineReferenceContext
): StudioCompositionIssue[] => {
  const references: FileReference[] = [
    ...(content.brief.productFileId
      ? [{ fileId: content.brief.productFileId, path: ['brief', 'productFileId'], kinds: PRODUCT_PHOTO_KINDS }]
      : []),
    ...(content.brandKit.logoFileId
      ? [{ fileId: content.brandKit.logoFileId, path: ['brandKit', 'logoFileId'], kinds: LOGO_KINDS }]
      : []),
    ...content.brandKit.productFileIds.map((fileId, index) => ({
      fileId,
      path: ['brandKit', 'productFileIds', index],
      kinds: PRODUCT_KINDS,
    })),
    ...content.brandKit.characters.map(({ fileId }, index) => ({
      fileId,
      path: ['brandKit', 'characters', index, 'fileId'],
      kinds: CHARACTER_KINDS,
    })),
    ...content.shots.flatMap((shot, shotIndex) => [
      ...shot.fileIds.map((fileId, index) => ({ fileId, path: ['shots', shotIndex, 'fileIds', index] })),
      ...(shot.clipFileId
        ? [{ fileId: shot.clipFileId, path: ['shots', shotIndex, 'clipFileId'], kinds: CLIP_KINDS }]
        : []),
    ]),
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
 * `timeline`), unique shot and character ids, chosen takes that are among the shot's takes, and, given the context, that the brief,
 * brand kit and shots reference only known files of a kind their slot accepts.
 */
export const validateStudioComposition = (
  content: StudioCompositionReferences,
  context: StudioTimelineReferenceContext = {}
): StudioCompositionIssue[] => [
  ...validateStudioTimeline(content.timeline, context).map(issue => ({ ...issue, path: ['timeline', ...issue.path] })),
  ...duplicateIds(content.shots, ['shots'], 'Shot'),
  ...duplicateIds(content.brandKit.characters, ['brandKit', 'characters'], 'Character'),
  ...validateChosenTakes(content),
  ...validateFileReferences(content, context),
];
