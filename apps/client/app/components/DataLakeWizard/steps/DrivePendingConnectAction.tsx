import { Button, Chip, Stack, Tooltip, Typography } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import CloseIcon from '@mui/icons-material/Close';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useDriveFolderPicker } from '@client/app/hooks/data/useDriveFolderPicker';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';

/**
 * Pick a Google Drive folder while CREATING a data lake. There is no lake id to bind to yet, so the
 * selection is parked in wizard state and connected on commit - which is what lets a lake be created
 * from a Drive folder alone, with no local files, and lets abandoning the wizard leave nothing behind
 * (#1916). The existing-lake surface is DriveConnectAction, which connects immediately.
 */
export default function DrivePendingConnectAction() {
  const pendingDriveFolder = useDataLakeWizardStore(s => s.pendingDriveFolder);
  const setPendingDriveFolder = useDataLakeWizardStore(s => s.setPendingDriveFolder);

  // POST /api/data-lakes/drive-sync refuses a lake with no organizationId, and the wizard creates
  // the lake in whatever scope the account switcher is on - so in Personal scope this action could
  // only ever create a lake and then fail to connect it. Same condition as SelectedLakeHeader's
  // canConnectDrive, minus the role half: create mode has no lake to read canManage off, so org
  // owner/manager stays the server's call and a refusal rolls the new lake back (see
  // useCreateLakeFromDrive).
  const selectedAccount = useSelectedAccount(s => s.selectedAccount);
  const isOrgScope = !!selectedAccount && !selectedAccount.personal;

  const { openFolderPicker, isPicking } = useDriveFolderPicker({
    onPicked: folder => setPendingDriveFolder(folder),
  });

  if (!isOrgScope) {
    return (
      <Tooltip
        title={`Google Drive folders can only feed an organization ${DATA_LAKE}. Switch to your organization in the account selector, then connect a folder.`}
      >
        <span>
          <Button
            data-testid="drive-connect-personal-scope-btn"
            variant="outlined"
            color="neutral"
            startDecorator={<CloudIcon />}
            disabled
          >
            Connect Google Drive
          </Button>
        </span>
      </Tooltip>
    );
  }

  if (pendingDriveFolder) {
    return (
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" data-testid="drive-pending-selection">
        <Chip
          variant="soft"
          color="primary"
          startDecorator={<CloudIcon sx={{ fontSize: 16 }} />}
          endDecorator={
            <Button
              data-testid="drive-pending-clear-btn"
              size="sm"
              variant="plain"
              color="neutral"
              aria-label="Remove the selected Google Drive folder"
              onClick={() => setPendingDriveFolder(null)}
              sx={{ minHeight: 0, minWidth: 0, p: 0.25 }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </Button>
          }
        >
          {pendingDriveFolder.folderName || pendingDriveFolder.driveFolderId}
        </Chip>
        <Typography level="body-xs" color="neutral">
          Connects when you create the {DATA_LAKE}
        </Typography>
        <Button
          data-testid="drive-pending-change-btn"
          size="sm"
          variant="plain"
          color="neutral"
          loading={isPicking}
          onClick={openFolderPicker}
        >
          Change folder
        </Button>
      </Stack>
    );
  }

  return (
    <Button
      data-testid="drive-connect-btn"
      variant="outlined"
      color="neutral"
      startDecorator={<CloudIcon />}
      loading={isPicking}
      onClick={openFolderPicker}
    >
      Connect Google Drive
    </Button>
  );
}
