import { Box, Button, Chip, Tooltip, Typography } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import StorageIcon from '@mui/icons-material/Storage';
import { useArchiveDataLake } from '@client/app/hooks/data/dataLakes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import DataLakeEmptyState from '@client/app/components/datalake/DataLakeEmptyState';
import { TREE_SCROLL_SX } from '@client/app/components/datalake/treeChrome';
import type { IDataLakeBatchSummary } from '@bike4mind/common';
import type { ManagerLake } from './shared';

// Right pane: selected lake's details + management actions

export function LakeInfoPanel({
  lake,
  fileCount,
  taxonomyBatch,
  onOpenSettings,
  onReviewTaxonomy,
  onArchived,
}: {
  lake: ManagerLake;
  fileCount: number | undefined;
  /** This lake's attention-worthy taxonomy batch, if any (see taxonomyBatchByLakeId). */
  taxonomyBatch: IDataLakeBatchSummary | undefined;
  onOpenSettings: () => void;
  /** Opens the review/apply panel for a batch whose taxonomy suggestions are ready or failed. */
  onReviewTaxonomy: (batchId: string) => void;
  /** Called after the active lake is archived, so the panel exits to root instead of the
   *  derived activeLake re-binding to a lake that just left the list (and a later restore
   *  teleporting back in). */
  onArchived: () => void;
}) {
  const openWizardForLake = useDataLakeWizardStore(s => s.openWizardForLake);
  const archiveLake = useArchiveDataLake();
  const visibility = lake.isPublic ? 'Public' : lake.organizationId ? 'Organization' : 'Private';

  return (
    <Box
      data-testid="datalake-manager-lakeinfo"
      sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
    >
      {/* pr clears the modal's absolutely-positioned ModalClose (top-right). */}
      <Box sx={{ px: 3, pr: 6, pt: 2.5, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
          <Typography level="h4" sx={{ flex: 1, minWidth: 0 }}>
            {lake.name}
          </Typography>
          {/* Add files / Settings / Archive are owner-or-admin only (the backend enforces the
              same rule). The nav surfaces other users' read-only public lakes too. */}
          {lake.canManage && (
            <>
              <Button
                size="sm"
                variant="soft"
                color="primary"
                startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-addfiles-btn-${lake.id}`}
                onClick={() =>
                  openWizardForLake({
                    id: lake.id,
                    slug: lake.slug,
                    name: lake.name,
                    fileTagPrefix: lake.fileTagPrefix,
                    requiredUserTag: lake.requiredUserTag,
                    requiredEntitlement: lake.requiredEntitlement,
                  })
                }
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Add files
              </Button>
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-settings-btn-${lake.id}`}
                onClick={onOpenSettings}
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Settings
              </Button>
              <Tooltip title="Archive (restorable from the manager home)" size="sm">
                <Button
                  size="sm"
                  variant="outlined"
                  color="warning"
                  startDecorator={<ArchiveOutlinedIcon sx={{ fontSize: 16 }} />}
                  data-testid={`datalake-archive-btn-${lake.id}`}
                  loading={archiveLake.isPending}
                  onClick={() => archiveLake.mutate(lake.id, { onSuccess: onArchived })}
                  sx={{ flexShrink: 0, fontSize: '13px' }}
                >
                  Archive
                </Button>
              </Tooltip>
            </>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          <Chip size="sm" variant="soft" color="neutral" sx={{ fontSize: '11px' }}>
            {lake.fileTagPrefix}
          </Chip>
          {lake.requiredUserTag && (
            <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '11px' }}>
              {lake.requiredUserTag}
            </Chip>
          )}
          <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '11px' }}>
            {visibility}
          </Chip>
          {typeof fileCount === 'number' && (
            <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '11px' }}>
              {fileCount} {fileCount === 1 ? 'file' : 'files'}
            </Chip>
          )}
          {/* Background AI-tag suggestion progress - an independent clock from ingest, so this
              can appear well after the lake's files are already fully uploaded/searchable. */}
          {(taxonomyBatch?.taxonomyStatus === 'queued' || taxonomyBatch?.taxonomyStatus === 'analyzing') && (
            <Tooltip title="Usually ready in under a minute" size="sm">
              <Chip
                size="sm"
                variant="soft"
                color="primary"
                startDecorator={<AutoAwesomeIcon sx={{ fontSize: 12 }} />}
                sx={{ fontSize: '11px' }}
                data-testid={`datalake-manager-taxonomy-progress-chip-${lake.id}`}
              >
                AI tagging&hellip;
              </Chip>
            </Tooltip>
          )}
          {taxonomyBatch?.taxonomyStatus === 'ready' && (
            <Chip
              size="sm"
              variant="solid"
              color="success"
              startDecorator={<AutoAwesomeIcon sx={{ fontSize: 12 }} />}
              sx={{ fontSize: '11px', cursor: 'pointer' }}
              data-testid={`datalake-manager-taxonomy-review-chip-${lake.id}`}
              onClick={() => onReviewTaxonomy(taxonomyBatch.id)}
            >
              Review AI tags
            </Chip>
          )}
          {taxonomyBatch?.taxonomyStatus === 'failed' && (
            <Chip
              size="sm"
              variant="soft"
              color="warning"
              startDecorator={<ErrorOutlineIcon sx={{ fontSize: 12 }} />}
              sx={{ fontSize: '11px', cursor: 'pointer' }}
              data-testid={`datalake-manager-taxonomy-failed-chip-${lake.id}`}
              onClick={() => onReviewTaxonomy(taxonomyBatch.id)}
            >
              AI tagging failed
            </Chip>
          )}
        </Box>
      </Box>
      <Box sx={{ ...TREE_SCROLL_SX, px: 3, py: 2 }}>
        {lake.description ? (
          <Typography level="body-md" sx={{ whiteSpace: 'pre-wrap' }}>
            {lake.description}
          </Typography>
        ) : (
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            No description.
          </Typography>
        )}
        <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 2 }}>
          Browse the categories and files in the left sidebar - click a file to read it here.
        </Typography>
      </Box>
    </Box>
  );
}

// Right pane at root: pick-a-lake hint (the lifecycle sections live in the sidebar accordions)

export function ManagerOverview() {
  return (
    <DataLakeEmptyState
      icon={<StorageIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />}
      title="Select a data lake"
      data-testid="datalake-manager-overview"
    >
      Pick a lake on the left to see its details
      <br /> and browse its files, or create a new one.
    </DataLakeEmptyState>
  );
}
