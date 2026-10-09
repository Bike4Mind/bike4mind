import { Box, Button, Typography } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { useState } from 'react';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useLakeGitHubConnection } from '@client/app/hooks/data/githubLake';
import type { LakeSourceKind, LakeSourcePanelLake } from '@client/app/components/datalake/lakeSources';
import ConnectSourceMenu from './ConnectSourceMenu';
import LakeSourceConnectModal from './LakeSourceConnectModal';
import type { DataLakeEmptyVariant } from './resolveEmptyVariant';

const EMPTY_STATE_SX = {
  px: 2,
  py: 3,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 1,
  textAlign: 'center',
} as const;

interface DataLakeTreeEmptyStateProps {
  variant: Exclude<DataLakeEmptyVariant, 'no-selection'>;
  /** Create a lake - offered only in `no-lakes`. */
  onCreate?: () => void;
  /** Re-read the lake list - offered only in `lakes-error`. */
  onRetryLakes?: () => void;
  /** Add files to the scoped lake - offered only in `lake-empty`. */
  onAddFiles?: () => void;
  /** The scoped lake, which decides the sources it can take. Offered only with `onAddFiles`. */
  sourceLake?: LakeSourcePanelLake;
}

/**
 * The in-chat tree's "nothing to browse" state, shown in place of the bare "No categories" line
 * when the reason is knowable from the lake list rather than the tag tree (#1943). The precedence
 * that decides WHICH reason lives in resolveEmptyVariant; this only renders the answer.
 *
 * `no-selection` is excluded by the type: it asserts nothing about why the tree is empty, so the
 * tree keeps its own neutral line for that case rather than being handed an empty box to render.
 *
 * Deliberately NOT built on DataLakeEmptyState, which serves the manager's right pane and the
 * Discover catalog: that one is a pane-filling state (flex: 1, centred, 40px icon badge,
 * title-lg, 380px body) and renders its `children` inside a Typography, so it has nowhere to put
 * the Create / Retry / Add-files button - a <button> in a <p>. This one is a compact block in a
 * 260px rail whose whole point is the action. Same feature, different container; if a third
 * caller ever wants THIS shape, deepen this component rather than widening that one.
 */
export default function DataLakeTreeEmptyState({
  variant,
  onCreate,
  onRetryLakes,
  onAddFiles,
  sourceLake,
}: DataLakeTreeEmptyStateProps) {
  const { copy } = useDataLakeSurface();
  const [connectingKind, setConnectingKind] = useState<LakeSourceKind | null>(null);
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  // Same gate as the lake's GitHub source (lakeSources.ts): the connection read 403s with the flag
  // off and refuses a caller who cannot manage an org lake. Shares the source card's poll.
  const watchGitHub =
    variant === 'lake-empty' &&
    !!sourceLake?.organizationId &&
    !!sourceLake.canManage &&
    isAdminFeatureEnabled('EnableDataLakeGitHub');
  const { data: gitHubConnection } = useLakeGitHubConnection(sourceLake?.id, watchGitHub);

  // Drive connects from the wizard's source step, beside its what-it-can-read disclosure, so it
  // routes through the same wizard Add files opens. Every other source opens its own panel directly.
  const connectSource = (kind: LakeSourceKind) => {
    if (kind === 'googleDrive') onAddFiles?.();
    else setConnectingKind(kind);
  };

  const { title, hint } = {
    'no-lakes': { title: copy.zeroTitle, hint: copy.zeroHint },
    'lakes-error': { title: copy.lakesErrorTitle, hint: copy.lakesErrorHint },
    'lake-empty': { title: copy.lakeEmptyTitle, hint: copy.lakeEmptyHint },
    'lakes-empty': { title: copy.lakesEmptyTitle, hint: copy.lakesEmptyHint },
    'all-lakes-empty': { title: copy.allLakesEmptyTitle, hint: copy.allLakesEmptyHint },
  }[variant];

  // A connected repo's first files are still on their way: say so instead of offering to add files.
  // The live count stays on the source card above (GitHubConnectAction), which shares this pane.
  if (watchGitHub && gitHubConnection?.status === 'syncing' && !gitHubConnection.syncStale) {
    return (
      <Box data-testid="datalake-tree-empty" data-variant="github-syncing" sx={EMPTY_STATE_SX}>
        <Typography level="title-sm" sx={{ overflowWrap: 'anywhere' }} data-testid="datalake-tree-empty-github-syncing">
          Syncing {gitHubConnection.repositoryFullName}
          {gitHubConnection.defaultBranch && ` (${gitHubConnection.defaultBranch})`}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Files appear here as they are indexed.
        </Typography>
      </Box>
    );
  }

  return (
    <Box data-testid="datalake-tree-empty" data-variant={variant} sx={EMPTY_STATE_SX}>
      <Typography level="title-sm">{title}</Typography>
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        {hint}
      </Typography>
      {variant === 'no-lakes' && onCreate && (
        <Button
          size="sm"
          variant="solid"
          color="primary"
          startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
          data-testid="datalake-tree-empty-create-btn"
          onClick={onCreate}
        >
          {copy.createLabel}
        </Button>
      )}
      {variant === 'lakes-error' && onRetryLakes && (
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
          data-testid="datalake-tree-empty-retry-btn"
          onClick={onRetryLakes}
        >
          Retry
        </Button>
      )}
      {variant === 'lake-empty' && onAddFiles && (
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<UploadFileIcon sx={{ fontSize: 16 }} />}
          data-testid="datalake-tree-empty-addfiles-btn"
          onClick={onAddFiles}
        >
          Add files
        </Button>
      )}
      {variant === 'lake-empty' && onAddFiles && sourceLake && (
        <>
          <ConnectSourceMenu lake={sourceLake} onConnect={connectSource} />
          <LakeSourceConnectModal lake={sourceLake} kind={connectingKind} onClose={() => setConnectingKind(null)} />
        </>
      )}
    </Box>
  );
}
