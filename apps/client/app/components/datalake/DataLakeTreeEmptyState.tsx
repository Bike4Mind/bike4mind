import { Box, Button, Typography } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import type { DataLakeEmptyVariant } from './resolveEmptyVariant';

interface DataLakeTreeEmptyStateProps {
  variant: Exclude<DataLakeEmptyVariant, 'no-selection'>;
  /** Create a lake - offered only in `no-lakes`. */
  onCreate?: () => void;
  /** Re-read the lake list - offered only in `lakes-error`. */
  onRetryLakes?: () => void;
  /** Add files to the scoped lake - offered only in `lake-empty`. */
  onAddFiles?: () => void;
}

/**
 * The in-chat tree's "nothing to browse" state, shown in place of the bare "No categories" line
 * when the reason is knowable from the lake list rather than the tag tree (#1943). The precedence
 * that decides WHICH reason lives in resolveEmptyVariant; this only renders the answer.
 *
 * `no-selection` is excluded by the type: it asserts nothing about why the tree is empty, so the
 * tree keeps its own neutral line for that case rather than being handed an empty box to render.
 */
export default function DataLakeTreeEmptyState({
  variant,
  onCreate,
  onRetryLakes,
  onAddFiles,
}: DataLakeTreeEmptyStateProps) {
  const { copy } = useDataLakeSurface();

  const { title, hint } = {
    'no-lakes': { title: copy.zeroTitle, hint: copy.zeroHint },
    'lakes-error': { title: copy.lakesErrorTitle, hint: copy.lakesErrorHint },
    'lake-empty': { title: copy.lakeEmptyTitle, hint: copy.lakeEmptyHint },
    'all-lakes-empty': { title: copy.allLakesEmptyTitle, hint: copy.allLakesEmptyHint },
  }[variant];

  return (
    <Box
      data-testid="datalake-tree-empty"
      data-variant={variant}
      sx={{ px: 2, py: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, textAlign: 'center' }}
    >
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
    </Box>
  );
}
