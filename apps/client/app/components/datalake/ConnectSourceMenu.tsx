import { Dropdown, ListItemContent, ListItemDecorator, Menu, MenuButton, MenuItem, Typography } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import GitHubIcon from '@mui/icons-material/GitHub';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { DRIVE_ORG_ONLY_REASON } from '@client/app/components/DataLakeWizard/steps/DriveConnectUnavailableButton';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';

export const GITHUB_ORG_ONLY_REASON = `GitHub repositories can only feed an organization ${DATA_LAKE}.`;

type ConnectSourceMenuProps = {
  lake: { organizationId?: string | null };
  /** Take the user to where a Drive folder is picked. */
  onConnectDrive: () => void;
  /** Take the user to where a GitHub repository is connected. */
  onConnectGitHub: () => void;
};

/**
 * The lake-level list of external sources that can feed a lake, so a manager can tell from the lake
 * itself that it need not be fed by upload alone. One item per source; a source the lake's scope
 * cannot hold stays listed, disabled, with the reason inline rather than in a tooltip a disabled
 * item cannot raise.
 *
 * The org gate must stay in sync with canConnectLakeDrive (lakeVisibility.ts), which both sources
 * share. The manage half of that gate is the caller's: this renders only where the user can
 * already add files. GitHub is hidden outright while EnableDataLakeGitHub is off, since every one
 * of its routes 403s until then.
 */
export default function ConnectSourceMenu({ lake, onConnectDrive, onConnectGitHub }: ConnectSourceMenuProps) {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const gitHubEnabled = isAdminFeatureEnabled('EnableDataLakeGitHub');
  const driveUnavailableReason = lake.organizationId ? undefined : DRIVE_ORG_ONLY_REASON;
  const gitHubUnavailableReason = lake.organizationId ? undefined : GITHUB_ORG_ONLY_REASON;

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
        {gitHubEnabled && (
          <MenuItem
            data-testid="datalake-connect-source-github-item"
            disabled={!!gitHubUnavailableReason}
            onClick={onConnectGitHub}
          >
            <ListItemDecorator>
              <GitHubIcon />
            </ListItemDecorator>
            <ListItemContent>
              GitHub
              <Typography
                level="body-xs"
                data-testid="datalake-connect-source-github-hint"
                sx={{ color: 'text.tertiary', whiteSpace: 'normal' }}
              >
                {gitHubUnavailableReason ?? 'Sync a repository into this lake'}
              </Typography>
            </ListItemContent>
          </MenuItem>
        )}
      </Menu>
    </Dropdown>
  );
}
