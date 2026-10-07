import { useEffect } from 'react';
import { Button, Chip, Stack, Typography } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import CloseIcon from '@mui/icons-material/Close';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useDriveFolderPicker } from '@client/app/hooks/data/useDriveFolderPicker';
import { activeOrgId } from '@client/app/hooks/data/dataLakes';
import { useUser } from '@client/app/contexts/UserContext';
import { saveDriveConnectHandoff, takeDrivePickerResume } from '@client/app/utils/driveConnectHandoff';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import DriveAccessDisclosure from './DriveAccessDisclosure';

/**
 * Pick a Google Drive folder while CREATING a data lake. There is no lake id to bind to yet, so the
 * selection is parked in wizard state and connected on commit - which is what lets a lake be created
 * from a Drive folder alone, with no local files, and lets abandoning the wizard leave nothing behind
 * (#1916). The existing-lake surface is DriveConnectAction, which connects immediately.
 *
 * Offered in every account scope: the wizard creates the lake in whatever scope the account switcher
 * is on, and drive-sync accepts both - an org lake from an org owner/manager, a personal lake from
 * its creator (the caller, here). Create mode has no lake to read canManage off, so the org role
 * stays the server's call and a refusal rolls the new lake back (see useCreateLakeFromDrive).
 *
 * A first-time connect leaves the page for Google consent, so the wizard's typed-in config is saved
 * first; the Drive callback route reopens the wizard from it and asks this action to open the picker.
 */
export default function DrivePendingConnectAction() {
  const pendingDriveFolder = useDataLakeWizardStore(s => s.pendingDriveFolder);
  const setPendingDriveFolder = useDataLakeWizardStore(s => s.setPendingDriveFolder);

  const { openFolderPicker, isPicking } = useDriveFolderPicker({
    onPicked: folder => setPendingDriveFolder(folder),
    onBeforeRedirect: authUrl => {
      const userId = useUser.getState().currentUser?.id;
      if (!userId) return;
      const { config, autoDerivedTagPrefix, optionalSteps } = useDataLakeWizardStore.getState();
      saveDriveConnectHandoff(
        {
          kind: 'createWizard',
          userId,
          organizationId: activeOrgId() ?? null,
          config,
          autoDerivedTagPrefix,
          optionalSteps,
        },
        authUrl
      );
    },
  });

  useEffect(() => {
    if (takeDrivePickerResume()) void openFolderPicker();
    // Mount-only: the resume signal is one-shot and only meaningful as the resumed wizard appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <Stack gap={0.5}>
      <Button
        data-testid="drive-connect-btn"
        variant="outlined"
        color="neutral"
        startDecorator={<CloudIcon />}
        loading={isPicking}
        onClick={openFolderPicker}
        sx={{ alignSelf: 'flex-start' }}
      >
        Connect Google Drive
      </Button>
      <DriveAccessDisclosure />
    </Stack>
  );
}
