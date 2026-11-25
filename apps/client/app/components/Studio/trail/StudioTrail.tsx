import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { styled } from '@mui/system';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import GraphicEqRoundedIcon from '@mui/icons-material/GraphicEqRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import type { GeneratedAssetGenerator, GeneratedAssetLineageRole } from '@bike4mind/common';
import type { FileLineage, LineageEdge, LineageNode, VisibleLineageNode } from '@server/files/fileLineage';
import { useFileLineage } from '@client/app/hooks/data/fileLineage';
import type { StudioRestoreRequest } from '@client/app/components/Studio/restore/studioRestore';
import type { StudioMedium } from '@client/app/components/Studio/studioModality';
import { StudioSectionLabel } from '@client/app/components/Studio/design/StudioPanel';
import { StudioSkeletonBlock, StudioTakesMessage } from '@client/app/components/Studio/design/StudioTakesStates';
import {
  STUDIO_FOCUS_VISIBLE,
  studioColor,
  studioFont,
  studioRadius,
} from '@client/app/components/Studio/design/studioTokens';

export const LINEAGE_ROLE_LABELS: Record<GeneratedAssetLineageRole, string> = {
  first_frame: 'First frame',
  last_frame: 'Last frame',
  reference: 'Reference',
  style: 'Style',
  extend_of: 'Extended',
  variation_of: 'Variation of',
  edit_source: 'Edit source',
  mask: 'Mask',
  scene_video: 'Scene video',
  scene_audio: 'Soundtrack',
  scene_cover: 'Cover art',
  timeline_clip: 'Timeline clip',
};

// null: no Studio form takes the generator's request back (a Scene is composed, not generated from a form).
const GENERATOR_MEDIUM: Record<GeneratedAssetGenerator, StudioMedium | null> = {
  image: 'image',
  video: 'video',
  music: 'music',
  speech: 'speech',
  sound_effect: 'sound-effects',
  scene: null,
};

export type StudioTrailRestore = (restore: StudioRestoreRequest) => void;

type StepRestore = (fileId: string, request: Record<string, unknown>, medium: StudioMedium) => void;

type StudioTrailProps = {
  fileId: string;
  /** Called with a step's stored request; steps are clickable only when this is set. */
  onRestore?: StudioTrailRestore;
};

// px; wide enough for a two-line prompt under the thumbnail, narrow enough that a few steps fit the dialog.
const STEP_WIDTH = 148;
const SKELETON_STEP_COUNT = 3;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const stripStyle = {
  display: 'flex',
  alignItems: 'stretch',
  gap: '4px',
  margin: 0,
  padding: '2px 2px 8px',
  listStyle: 'none',
  overflowX: 'auto',
  scrollSnapType: 'x proximity',
  scrollbarWidth: 'thin',
} as const;

const OrderedStrip = styled('ol')(stripStyle);
const UnorderedStrip = styled('ul')(stripStyle);
const LoadingStrip = styled('div')(stripStyle);

const StripItem = styled('li')({ display: 'flex', alignItems: 'stretch', flexShrink: 0, scrollSnapAlign: 'start' });

// Centred on the thumbnail, so the arrows read as one line through the strip.
const Connector = styled('span')({
  display: 'flex',
  alignSelf: 'flex-start',
  alignItems: 'center',
  height: `${STEP_WIDTH}px`,
  color: studioColor('text-muted'),
  '& svg': { fontSize: '20px' },
});

// Steps of one generation (several parents of the same take) stack, so no arrow implies one made the other.
const Generation = styled('div')({ display: 'flex', flexDirection: 'column', gap: '8px' });

const stepStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  width: `${STEP_WIDTH}px`,
  margin: 0,
  padding: '10px',
  borderRadius: studioRadius('lg'),
  border: `1px solid ${studioColor('hairline')}`,
  backgroundColor: studioColor('surface'),
  color: studioColor('text'),
  font: `400 12px/1.4 ${studioFont('ui')}`,
  textAlign: 'left',
  '&[data-current="true"]': {
    borderColor: studioColor('accent-border'),
    backgroundColor: studioColor('accent-soft'),
  },
} as const;

const StaticStep = styled('div')(stepStyle);

const RestorableStep = styled('button')({
  ...stepStyle,
  cursor: 'pointer',
  transition: 'background-color 120ms ease, border-color 120ms ease',
  '&:hover': { backgroundColor: studioColor('hover'), borderColor: studioColor('border-strong') },
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
});

const ThumbnailFrame = styled('span')({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  aspectRatio: '1 / 1',
  overflow: 'hidden',
  borderRadius: studioRadius('md'),
  border: `1px solid ${studioColor('hairline')}`,
  backgroundColor: studioColor('sunken'),
  color: studioColor('text-muted'),
  '& svg': { fontSize: '28px' },
  '& img': { width: '100%', height: '100%', objectFit: 'cover' },
});

const CurrentBadge = styled('span')({
  position: 'absolute',
  top: '6px',
  left: '6px',
  padding: '2px 8px',
  borderRadius: studioRadius('pill'),
  backgroundColor: studioColor('accent'),
  color: studioColor('accent-contrast'),
  font: `600 10px/1.4 ${studioFont('ui')}`,
  whiteSpace: 'nowrap',
});

const StepTitle = styled('span')({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  font: `500 11px/1.3 ${studioFont('mono')}`,
  color: studioColor('text-strong'),
  '&[data-muted="true"]': { fontFamily: studioFont('ui'), color: studioColor('text-muted') },
});

const StepPrompt = styled('span')({
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  color: studioColor('text-secondary'),
});

const StepDate = styled('span')({ font: `400 10px/1.3 ${studioFont('mono')}`, color: studioColor('text-muted') });

const RoleTags = styled('span')({ display: 'flex', flexWrap: 'wrap', gap: '4px' });

const RoleTag = styled('span')({
  padding: '2px 8px',
  borderRadius: studioRadius('pill'),
  border: `1px solid ${studioColor('accent-border')}`,
  backgroundColor: studioColor('accent-soft'),
  color: studioColor('accent-on-soft'),
  font: `500 10px/1.4 ${studioFont('ui')}`,
});

const TruncatedNote = styled('p')({
  margin: 0,
  font: `400 12px/1.4 ${studioFont('ui')}`,
  color: studioColor('text-muted'),
});

const TrailRoot = styled('div')({ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 });

const SkeletonStep = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  width: `${STEP_WIDTH}px`,
  padding: '10px',
  borderRadius: studioRadius('lg'),
  border: `1px solid ${studioColor('hairline')}`,
  backgroundColor: studioColor('surface'),
});

const MediaIcon = ({ mimeType }: { mimeType: string }) => {
  if (mimeType.startsWith('video/')) return <MovieOutlinedIcon />;
  if (mimeType.startsWith('audio/')) return <GraphicEqRoundedIcon />;
  return <InsertDriveFileOutlinedIcon />;
};

const Thumbnail = ({ node, isCurrent }: { node: VisibleLineageNode; isCurrent?: boolean }) => (
  <ThumbnailFrame>
    {node.url && node.mimeType.startsWith('image/') ? (
      <img src={node.url} alt={node.prompt ?? node.fileName} loading="lazy" />
    ) : (
      <MediaIcon mimeType={node.mimeType} />
    )}
    {isCurrent && <CurrentBadge>This take</CurrentBadge>}
  </ThumbnailFrame>
);

const RoleChips = ({ roles, testId }: { roles: GeneratedAssetLineageRole[]; testId: string }) =>
  roles.length === 0 ? null : (
    <RoleTags data-testid={testId}>
      {[...new Set(roles)].map(role => (
        <RoleTag key={role}>{LINEAGE_ROLE_LABELS[role]}</RoleTag>
      ))}
    </RoleTags>
  );

const restorableMedium = (node: VisibleLineageNode): StudioMedium | null =>
  node.request && node.generator ? GENERATOR_MEDIUM[node.generator] : null;

type StepProps = {
  node: LineageNode;
  /** How this node fed the next step: the roles on its edge(s). */
  roles: GeneratedAssetLineageRole[];
  isCurrent?: boolean;
  onRestore?: StepRestore;
  /** False for an export: its stored request is not a Create form's, so there is nothing to restore. */
  restorable?: boolean;
};

const VisibleStep = ({
  node,
  roles,
  isCurrent,
  onRestore,
  restorable = true,
}: StepProps & { node: VisibleLineageNode }) => {
  const medium = restorableMedium(node);
  const title = node.modelId ?? (node.generator ? 'Generated' : 'Uploaded file');
  const content = (
    <>
      <Thumbnail node={node} isCurrent={isCurrent} />
      <StepTitle data-muted={!node.modelId} title={title}>
        {title}
      </StepTitle>
      {node.prompt && <StepPrompt>{node.prompt}</StepPrompt>}
      {node.createdAt && <StepDate>{dateFormat.format(new Date(node.createdAt))}</StepDate>}
      <RoleChips roles={roles} testId={`studio-trail-roles-${node.fileId}`} />
    </>
  );

  if (!onRestore || !restorable || !medium || !node.request) {
    return (
      <StaticStep data-testid={`studio-trail-step-${node.fileId}`} data-restorable="false" data-current={!!isCurrent}>
        {content}
      </StaticStep>
    );
  }
  const request = node.request;
  return (
    <RestorableStep
      type="button"
      data-testid={`studio-trail-step-${node.fileId}`}
      data-restorable="true"
      data-current={!!isCurrent}
      title="Use these settings"
      onClick={() => onRestore(node.fileId, request, medium)}
    >
      {content}
    </RestorableStep>
  );
};

const RedactedStep = ({ node, roles }: StepProps) => (
  <StaticStep data-testid={`studio-trail-redacted-${node.fileId}`}>
    <ThumbnailFrame>
      <LockOutlinedIcon />
    </ThumbnailFrame>
    <StepTitle data-muted="true">Not available</StepTitle>
    <RoleChips roles={roles} testId={`studio-trail-roles-${node.fileId}`} />
  </StaticStep>
);

const Step = (props: StepProps) =>
  props.node.redacted ? <RedactedStep {...props} /> : <VisibleStep {...props} node={props.node} />;

/** Steps left to right; an ordered strip draws an arrow between each pair, an unordered one is a plain set. */
const StepStrip = ({
  children,
  testId,
  ordered = true,
  scrollToEnd = false,
}: {
  children: ReactNode[];
  testId: string;
  ordered?: boolean;
  /** Start scrolled to the newest step, so a long ancestry opens on the take itself. */
  scrollToEnd?: boolean;
}) => {
  const stripRef = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (scrollToEnd && strip) strip.scrollLeft = strip.scrollWidth;
  }, [scrollToEnd]);
  const items = children.map((child, index) => (
    <StripItem key={index}>
      {ordered && index > 0 && (
        <Connector aria-hidden="true">
          <ChevronRightRoundedIcon />
        </Connector>
      )}
      {child}
    </StripItem>
  ));
  return ordered ? (
    <OrderedStrip ref={stripRef} data-testid={testId}>
      {items}
    </OrderedStrip>
  ) : (
    <UnorderedStrip data-testid={testId}>{items}</UnorderedStrip>
  );
};

const rolesFrom = (edges: LineageEdge[], parentId: string) =>
  edges.filter(edge => edge.parentId === parentId).map(edge => edge.role);

/** Edges inside the ancestry; the root's edges to its children are shown under "Made from this" instead. */
const ancestorEdges = (lineage: FileLineage) => lineage.edges.filter(edge => edge.parentId !== lineage.fileId);

const rolesInto = (edges: LineageEdge[], parentId: string, childId: string) =>
  edges.filter(edge => edge.parentId === parentId && edge.childId === childId).map(edge => edge.role);

/** Files an export produced: a timeline clip feeds only a render, and a render's request is not a Create form's. */
const exportedFileIds = (lineage: FileLineage): Set<string> =>
  new Set(lineage.edges.filter(edge => edge.role === 'timeline_clip').map(edge => edge.childId));

/** Ancestors grouped by depth, oldest generation first, so the strip reads left to right in the order the take was made. */
const generationsInOrder = (lineage: FileLineage): LineageNode[][] => {
  const byDepth = new Map<number, LineageNode[]>();
  for (const node of lineage.ancestors) byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), node]);
  return [...byDepth.entries()].sort(([a], [b]) => b - a).map(([, nodes]) => nodes);
};

/** The files `fileId` was made from, with their roles, as its `derivedFrom` recorded them. */
const inputsOf = (lineage: FileLineage, fileId: string) =>
  lineage.edges.filter(edge => edge.childId === fileId).map(({ parentId, role }) => ({ fileId: parentId, role }));

/** Every walked file's name by id (null when redacted), so a restored request can show its input files by name. */
const fileNamesOf = (lineage: FileLineage): Record<string, string | null> =>
  Object.fromEntries(
    [...lineage.ancestors, ...lineage.children].map(node => [node.fileId, node.redacted ? null : node.fileName])
  );

const TrailBody = ({ lineage, onRestore }: { lineage: FileLineage; onRestore?: StepRestore }) => {
  const exported = exportedFileIds(lineage);
  return (
    <>
      {lineage.truncated && (
        <TruncatedNote data-testid="studio-trail-truncated">Earlier steps are not shown.</TruncatedNote>
      )}
      <StepStrip testId="studio-trail-ancestors" scrollToEnd>
        {generationsInOrder(lineage).map(nodes => (
          <Generation key={nodes[0].depth}>
            {nodes.map(node => (
              <Step
                key={node.fileId}
                node={node}
                roles={rolesFrom(ancestorEdges(lineage), node.fileId)}
                isCurrent={node.fileId === lineage.fileId}
                onRestore={onRestore}
                restorable={!exported.has(node.fileId)}
              />
            ))}
          </Generation>
        ))}
      </StepStrip>
      {lineage.children.length > 0 && (
        <TrailRoot>
          <StudioSectionLabel testId="studio-trail-children-label">Made from this</StudioSectionLabel>
          <StepStrip testId="studio-trail-children" ordered={false}>
            {lineage.children.map(child => (
              <Step
                key={child.fileId}
                node={child}
                roles={rolesInto(lineage.edges, lineage.fileId, child.fileId)}
                onRestore={onRestore}
                restorable={!exported.has(child.fileId)}
              />
            ))}
          </StepStrip>
        </TrailRoot>
      )}
    </>
  );
};

const TrailLoading = () => (
  <LoadingStrip role="status" aria-label="Loading the trail" data-testid="studio-trail-loading">
    {Array.from({ length: SKELETON_STEP_COUNT }, (_, index) => (
      <SkeletonStep key={index} aria-hidden>
        <StudioSkeletonBlock style={{ aspectRatio: '1 / 1', borderRadius: studioRadius('md') }} />
        <StudioSkeletonBlock style={{ height: '10px', width: '70%' }} />
        <StudioSkeletonBlock style={{ height: '10px' }} />
      </SkeletonStep>
    ))}
  </LoadingStrip>
);

/**
 * How a generated file was made, as a lineage strip: its ancestors oldest first, left to right, each tagged with
 * the role it played (first frame, reference, variation of, ...), then the files made from it. Ancestors the
 * viewer cannot read show as placeholders. Clicking a step hands its stored request to `onRestore`.
 * Reads the `--studio-*` tokens, so it must render under a StudioThemeScope (StudioTrailDialog brings its own).
 */
const StudioTrail = ({ fileId, onRestore }: StudioTrailProps) => {
  const lineage = useFileLineage(fileId);
  if (lineage.isPending) return <TrailLoading />;
  if (lineage.isError) {
    return (
      <StudioTakesMessage tone="danger" icon={<ErrorOutlineRoundedIcon />} testId="studio-trail-error">
        The trail could not be loaded.
      </StudioTakesMessage>
    );
  }
  return (
    <TrailRoot data-testid="studio-trail">
      <TrailBody
        lineage={lineage.data}
        onRestore={
          onRestore &&
          ((stepFileId, request, medium) =>
            onRestore({
              medium,
              request,
              lineageInputs: inputsOf(lineage.data, stepFileId),
              fileNames: fileNamesOf(lineage.data),
            }))
        }
      />
    </TrailRoot>
  );
};

export default StudioTrail;
