import { Button, Tooltip } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';

/** Why Drive is offered disabled on an existing personal lake - the org half of canConnectLakeDrive. */
export const DRIVE_ORG_ONLY_REASON = `Google Drive folders can only feed an organization ${DATA_LAKE}.`;

/**
 * A disabled "Connect Google Drive" that says why, for scopes that cannot hold a connection. It is
 * static on purpose: mounting DriveConnectAction would fire GET /drive-connection for a lake the
 * status route can only refuse.
 */
export default function DriveConnectUnavailableButton({ reason, testId }: { reason: string; testId: string }) {
  return (
    <Tooltip title={reason}>
      <span>
        <Button data-testid={testId} variant="outlined" color="neutral" startDecorator={<CloudIcon />} disabled>
          Connect Google Drive
        </Button>
      </span>
    </Tooltip>
  );
}
