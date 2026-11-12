import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemContent,
  ListItemDecorator,
  Stack,
  Typography,
} from '@mui/joy';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import type { GeneratedAssetGenerator, GeneratedAssetLineageRole } from '@bike4mind/common';
import type { FileLineage, LineageEdge, LineageNode, VisibleLineageNode } from '@server/files/fileLineage';
import { useFileLineage } from '@client/app/hooks/data/fileLineage';
import type { StudioMedium } from '@client/app/components/Studio/studioModality';

export const LINEAGE_ROLE_LABELS: Record<GeneratedAssetLineageRole, string> = {
  first_frame: 'First frame',
  last_frame: 'Last frame',
  reference: 'Reference',
  style: 'Style',
  extend_of: 'Extended',
  variation_of: 'Variation of',
  edit_source: 'Edit source',
  mask: 'Mask',
};

const GENERATOR_MEDIUM: Record<GeneratedAssetGenerator, StudioMedium> = {
  image: 'image',
  video: 'video',
  music: 'music',
  speech: 'speech',
  sound_effect: 'sound-effects',
};

export type StudioTrailRestore = (request: Record<string, unknown>, medium: StudioMedium) => void;

type StudioTrailProps = {
  fileId: string;
  /** Called with a step's stored request; steps are clickable only when this is set. */
  onRestore?: StudioTrailRestore;
};

const THUMB_SIZE = 56;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const Thumbnail = ({ node }: { node: VisibleLineageNode }) => (
  <Box
    sx={{
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      borderRadius: 'sm',
      overflow: 'hidden',
      bgcolor: 'background.level2',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    }}
  >
    {node.url && node.mimeType.startsWith('image/') ? (
      <Box
        component="img"
        src={node.url}
        alt={node.prompt ?? node.fileName}
        loading="lazy"
        sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    ) : (
      <InsertDriveFileOutlinedIcon />
    )}
  </Box>
);

const RoleChips = ({ roles, testId }: { roles: GeneratedAssetLineageRole[]; testId: string }) =>
  roles.length === 0 ? null : (
    <Stack direction="row" gap={0.5} flexWrap="wrap" data-testid={testId}>
      {[...new Set(roles)].map(role => (
        <Chip key={role} size="sm" variant="soft" color="primary">
          {LINEAGE_ROLE_LABELS[role]}
        </Chip>
      ))}
    </Stack>
  );

const restorableMedium = (node: VisibleLineageNode): StudioMedium | null =>
  node.request && node.generator ? GENERATOR_MEDIUM[node.generator] : null;

type StepProps = {
  node: LineageNode;
  /** How this node fed the next step: the roles on its edge(s). */
  roles: GeneratedAssetLineageRole[];
  isCurrent?: boolean;
  onRestore?: StudioTrailRestore;
};

const VisibleStep = ({ node, roles, isCurrent, onRestore }: StepProps & { node: VisibleLineageNode }) => {
  const medium = restorableMedium(node);
  const content = (
    <>
      <ListItemDecorator sx={{ mr: 1.5 }}>
        <Thumbnail node={node} />
      </ListItemDecorator>
      <ListItemContent>
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <Typography level="title-sm">{node.modelId ?? (node.generator ? 'Generated' : 'Uploaded file')}</Typography>
          {isCurrent && (
            <Chip size="sm" variant="outlined">
              This take
            </Chip>
          )}
        </Stack>
        {node.prompt && (
          <Typography
            level="body-sm"
            sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {node.prompt}
          </Typography>
        )}
        <Typography level="body-xs" textColor="text.tertiary">
          {dateFormat.format(new Date(node.createdAt))}
        </Typography>
        <RoleChips roles={roles} testId={`studio-trail-roles-${node.fileId}`} />
      </ListItemContent>
    </>
  );

  if (!onRestore || !medium || !node.request) {
    return (
      <ListItem data-testid={`studio-trail-step-${node.fileId}`} data-restorable="false">
        {content}
      </ListItem>
    );
  }
  const request = node.request;
  return (
    <ListItem>
      <ListItemButton
        data-testid={`studio-trail-step-${node.fileId}`}
        data-restorable="true"
        title="Use these settings"
        onClick={() => onRestore(request, medium)}
        sx={{ borderRadius: 'sm' }}
      >
        {content}
      </ListItemButton>
    </ListItem>
  );
};

const RedactedStep = ({ node, roles }: StepProps) => (
  <ListItem data-testid={`studio-trail-redacted-${node.fileId}`}>
    <ListItemDecorator sx={{ mr: 1.5 }}>
      <Box
        sx={{
          width: THUMB_SIZE,
          height: THUMB_SIZE,
          borderRadius: 'sm',
          bgcolor: 'background.level1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <LockOutlinedIcon />
      </Box>
    </ListItemDecorator>
    <ListItemContent>
      <Typography level="title-sm" textColor="text.tertiary">
        Not shared with you
      </Typography>
      <RoleChips roles={roles} testId={`studio-trail-roles-${node.fileId}`} />
    </ListItemContent>
  </ListItem>
);

const Step = (props: StepProps) =>
  props.node.redacted ? <RedactedStep {...props} /> : <VisibleStep {...props} node={props.node} />;

const rolesFrom = (edges: LineageEdge[], parentId: string) =>
  edges.filter(edge => edge.parentId === parentId).map(edge => edge.role);

/** Edges inside the ancestry; the root's edges to its children are shown under "Made from this" instead. */
const ancestorEdges = (lineage: FileLineage) => lineage.edges.filter(edge => edge.parentId !== lineage.fileId);

const rolesInto = (edges: LineageEdge[], parentId: string, childId: string) =>
  edges.filter(edge => edge.parentId === parentId && edge.childId === childId).map(edge => edge.role);

/** Oldest generation first, so the list reads top to bottom in the order the take was made. */
const stepsInOrder = (lineage: FileLineage) => [...lineage.ancestors].sort((a, b) => b.depth - a.depth);

const TrailBody = ({ lineage, onRestore }: { lineage: FileLineage; onRestore?: StudioTrailRestore }) => (
  <Stack gap={2}>
    {lineage.truncated && (
      <Typography level="body-xs" textColor="text.tertiary" data-testid="studio-trail-truncated">
        Earlier steps are not shown.
      </Typography>
    )}
    <List data-testid="studio-trail-ancestors" sx={{ '--ListItem-paddingX': 0, gap: 0.5 }}>
      {stepsInOrder(lineage).map(node => (
        <Step
          key={node.fileId}
          node={node}
          roles={rolesFrom(ancestorEdges(lineage), node.fileId)}
          isCurrent={node.fileId === lineage.fileId}
          onRestore={onRestore}
        />
      ))}
    </List>
    {lineage.children.length > 0 && (
      <Stack gap={0.5}>
        <Typography level="title-sm">Made from this</Typography>
        <List data-testid="studio-trail-children" sx={{ '--ListItem-paddingX': 0, gap: 0.5 }}>
          {lineage.children.map(child => (
            <Step
              key={child.fileId}
              node={child}
              roles={rolesInto(lineage.edges, lineage.fileId, child.fileId)}
              onRestore={onRestore}
            />
          ))}
        </List>
      </Stack>
    )}
  </Stack>
);

/**
 * How a generated file was made: its ancestors oldest first, each labelled with the role it played (first
 * frame, reference, variation of, ...), then the files made from it. Ancestors the viewer cannot read show as
 * placeholders. Clicking a step hands its stored request to `onRestore`.
 */
const StudioTrail = ({ fileId, onRestore }: StudioTrailProps) => {
  const lineage = useFileLineage(fileId);
  if (lineage.isPending) return <CircularProgress size="sm" data-testid="studio-trail-loading" />;
  if (lineage.isError) {
    return (
      <Alert color="danger" variant="soft" data-testid="studio-trail-error">
        The trail could not be loaded.
      </Alert>
    );
  }
  return (
    <Box data-testid="studio-trail">
      <TrailBody lineage={lineage.data} onRestore={onRestore} />
    </Box>
  );
};

export default StudioTrail;
