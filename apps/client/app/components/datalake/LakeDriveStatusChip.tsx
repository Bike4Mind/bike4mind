import { Chip, Tooltip } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import { useLakeDriveConnection } from '@client/app/hooks/data/googleDrive';
import { describeDriveConnection } from '@client/app/hooks/data/driveConnectionDisplay';

/**
 * Read-only "this lake has a Drive folder attached" marker, for the surfaces a user reaches when
 * they want to inspect or REMOVE a lake (#1645). Until this existed, a lake's detail panel showed
 * tag/scope/file-count/Delete and gave no sign a source was attached at all, so there was no way
 * to know something needed releasing before teardown - and purging strands the connection
 * permanently (#1807).
 *
 * A Drive connection is an ORG-lake concept, so a personal lake is not read at all - the route would
 * only ever 404. Beyond that, renders NOTHING when there is no connection, while the read is in
 * flight, or when the read fails (403 for a non-manager). Absence therefore means "no connection OR
 * not visible to you" - it is not a guarantee that none exists. Any surface making an irreversible
 * promise about the connection must consult the query itself rather than infer from this chip.
 */
export default function LakeDriveStatusChip({
  lakeId,
  organizationId,
}: {
  lakeId: string;
  /** The lake's org scope. Absent (personal lake) means no connection is possible, so none is read. */
  organizationId?: string;
}) {
  const { data: connection } = useLakeDriveConnection(lakeId, !!organizationId);
  if (!connection) return null;

  // Wording and severity both come from describeDriveConnection - notably it does NOT read a
  // 'connected' connection carrying a lastError as a healthy sync (see its doc).
  const { title, color } = describeDriveConnection(connection);
  const folder = connection.folderName || connection.driveFolderId;

  return (
    <Tooltip size="sm" title={title}>
      <Chip
        size="sm"
        variant="soft"
        color={color}
        startDecorator={<CloudIcon sx={{ fontSize: 12 }} />}
        sx={{ fontSize: '11px', maxWidth: 220 }}
        data-testid={`datalake-drive-status-chip-${lakeId}`}
      >
        {folder}
      </Chip>
    </Tooltip>
  );
}
