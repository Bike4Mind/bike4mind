import { Dropdown, ListItemContent, ListItemDecorator, Menu, MenuButton, MenuItem, Typography } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { DRIVE_ORG_ONLY_REASON } from '@client/app/components/DataLakeWizard/steps/DriveConnectUnavailableButton';

type ConnectSourceMenuProps = {
  lake: { organizationId?: string | null };
  /** Take the user to where a Drive folder is picked. */
  onConnectDrive: () => void;
};

/**
 * The lake-level list of external sources that can feed a lake, so a manager can tell from the lake
 * itself that it need not be fed by upload alone. One item per source; a source the lake's scope
 * cannot hold stays listed, disabled, with the reason inline rather than in a tooltip a disabled
 * item cannot raise.
 *
 * Drive's org gate must stay in sync with canConnectLakeDrive (lakeVisibility.ts). The manage half
 * of that gate is the caller's: this renders only where the user can already add files.
 */
export default function ConnectSourceMenu({ lake, onConnectDrive }: ConnectSourceMenuProps) {
  const driveUnavailableReason = lake.organizationId ? undefined : DRIVE_ORG_ONLY_REASON;

  return (
    <Dropdown>
      <MenuButton
        data-testid="datalake-connect-source-btn"
        size="sm"
        variant="plain"
        color="neutral"
        endDecorator={<KeyboardArrowDownIcon sx={{ fontSize: 16 }} />}
      >
        Connect a source
      </MenuButton>
      <Menu size="sm" placement="bottom" sx={{ maxWidth: 280 }}>
        <MenuItem
          data-testid="datalake-connect-source-drive-item"
          disabled={!!driveUnavailableReason}
          onClick={onConnectDrive}
        >
          <ListItemDecorator>
            <CloudIcon />
          </ListItemDecorator>
          <ListItemContent>
            Google Drive
            <Typography
              level="body-xs"
              data-testid="datalake-connect-source-drive-hint"
              sx={{ color: 'text.tertiary', whiteSpace: 'normal' }}
            >
              {driveUnavailableReason ?? 'Sync a Drive folder into this lake'}
            </Typography>
          </ListItemContent>
        </MenuItem>
      </Menu>
    </Dropdown>
  );
}
