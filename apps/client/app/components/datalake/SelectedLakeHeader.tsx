import { Box, Button, Chip, Stack, Tooltip } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import DriveConnectAction from '@client/app/components/DataLakeWizard/steps/DriveConnectAction';
import { lakeVisibilityLabel } from '@client/app/components/datalake/lakeVisibility';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import type { ManageableDataLakeConfig } from '@bike4mind/common';

/**
 * What the scoped lake is and the lake-level actions on it - the home those actions never had
 * (#1645). Lake-level work previously required Manage lakes -> pick a lake -> Add files, which
 * put "connect a Drive folder" three navigations deep and made an attached source invisible from
 * every surface but the wizard.
 *
 * Sits directly under DataLakeLakePicker inside the in-chat tree card, so it is laid out for that
 * card's width (#1943): the lake's NAME and file COUNT are on the picker trigger above and are
 * deliberately not repeated here. Rendered only when a specific lake is scoped, so the default
 * all-lakes view spends no vertical room on it.
 *
 * Lifecycle (archive / delete / purge / settings) is deliberately NOT duplicated here - it stays
 * in the manager panel, and Configure deep-links there with this lake preselected. A second set
 * of destructive controls on a second surface is how the two drift apart.
 */
export default function SelectedLakeHeader({ lake }: { lake: ManageableDataLakeConfig }) {
  const openWizardForLake = useDataLakeWizardStore(s => s.openWizardForLake);
  const openManager = useDataLakeWizardStore(s => s.openManager);

  // Drive connect is an org-lake, owner/manager capability server-side (the status route 404s on a
  // personal lake and 403s for a non-manager). Gating on the same condition keeps a permanently
  // disabled button off every personal lake's header, rather than offering an action that can only
  // ever fail.
  const canConnectDrive = !!lake.organizationId && !!lake.canManage;

  return (
    <Box
      data-testid="datalake-selected-lake-header"
      sx={{ px: '12px', pt: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}
    >
      <Stack direction="row" alignItems="center" gap={0.5} flexWrap="wrap">
        <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '11px' }}>
          {lakeVisibilityLabel(lake)}
        </Chip>
        <Chip
          size="sm"
          variant="soft"
          color="neutral"
          sx={{ fontSize: '11px' }}
          data-testid="datalake-selected-lake-prefix"
        >
          {lake.fileTagPrefix}
        </Chip>
      </Stack>

      <Stack direction="row" gap={0.5} flexWrap="wrap">
        {lake.canManage && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
            data-testid="datalake-selected-lake-addfiles-btn"
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
          >
            Add files
          </Button>
        )}
        <Tooltip title="Settings, archive and delete live in the manager" size="sm">
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
            data-testid="datalake-selected-lake-manage-btn"
            onClick={() => openManager('mine', lake.id)}
          >
            Configure
          </Button>
        </Tooltip>
      </Stack>

      {/* The source row: for an org lake this is the whole connect/re-sync/disconnect control, so
          attaching a Drive folder is one step from the chat instead of three. Its own controls
          wrap, which is what keeps it inside the tree card's width. */}
      {canConnectDrive && (
        <Box data-testid="datalake-selected-lake-source">
          <DriveConnectAction lake={{ id: lake.id }} />
        </Box>
      )}
    </Box>
  );
}
