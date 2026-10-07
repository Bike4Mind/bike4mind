import { Button, Tooltip } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';

/** Why Drive is offered disabled on a personal lake the caller did not create - the personal half of canConnectLakeDrive. */
export const DRIVE_PERSONAL_OWNER_ONLY_REASON = `Only the person who created a personal ${DATA_LAKE} can connect a Google Drive folder to it.`;

/**
 * A disabled "Connect Google Drive" that says why, for a lake the caller cannot connect. It is
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
