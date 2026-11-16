import { Box, Button, Skeleton, Stack } from '@mui/joy';
import { useAdminModelRow } from '@client/app/hooks/data/adminModels';
import { getErrorMessage } from '@client/app/utils/error';
import { EmptyState, ErrorState, UndoToastProvider } from '../../shared';
import { ADMIN_DETAIL_MAX_WIDTH, ADMIN_REGION_GAP, adminPageFrame } from '../../shared/adminStyles';
import type { ModelDetailTab } from '../modelDetailSearch';
import { useModelsNavigation } from '../modelsNavigation';
import { ModelDetailView } from './ModelDetailView';

function DetailSkeleton() {
  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="model-detail-loading" aria-busy="true">
      <Skeleton variant="text" level="body-sm" width={200} />
      <Skeleton variant="text" level="h1" width={320} />
      <Skeleton variant="rectangular" height={96} sx={{ borderRadius: 'lg' }} />
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        <Skeleton variant="rectangular" height={240} sx={{ borderRadius: 'lg' }} />
        <Skeleton variant="rectangular" height={240} sx={{ borderRadius: 'lg' }} />
      </Box>
    </Stack>
  );
}

/** One model at /admin/models/$ (a splat: ids keep their `/`); the admin layout guards it to admins. */
export function ModelDetailPage({
  modelId,
  tab,
  onTabChange,
}: {
  modelId: string;
  tab: ModelDetailTab;
  onTabChange: (tab: ModelDetailTab) => void;
}) {
  const row = useAdminModelRow(modelId);
  const { openSection } = useModelsNavigation();

  const body = () => {
    if (row.isPending) return <DetailSkeleton />;
    if (row.error && !row.data) {
      return (
        <ErrorState
          message={`This model could not be loaded. ${getErrorMessage(row.error)}`}
          onRetry={() => void row.refetch()}
          retrying={row.isFetching}
        />
      );
    }
    if (!row.data) {
      return (
        <Box data-testid="model-detail-not-found" sx={{ overflowWrap: 'anywhere' }}>
          <EmptyState
            title={`No model with id ${modelId}`}
            action={
              <Button
                variant="outlined"
                color="neutral"
                onClick={() => void openSection('list')}
                data-testid="model-detail-not-found-back-btn"
              >
                Back to models
              </Button>
            }
          />
        </Box>
      );
    }
    return (
      <ModelDetailView
        model={row.data}
        tab={tab}
        onTabChange={onTabChange}
        updating={row.isFetching && !row.isPending}
      />
    );
  };

  return (
    // Keyed so an undo offered on one model never carries over to the next.
    <UndoToastProvider key={modelId}>
      <Box sx={{ ...adminPageFrame, maxWidth: ADMIN_DETAIL_MAX_WIDTH }} data-testid="model-detail-page">
        {body()}
      </Box>
    </UndoToastProvider>
  );
}
