import { Stack } from '@mui/joy';
import {
  useOfferedLakeSources,
  type LakeSourceKind,
  type LakeSourceLake,
} from '@client/app/components/datalake/lakeSources';
import { useLakeDriveConnection } from '@client/app/hooks/data/googleDrive';
import { useLakeGitHubConnection } from '@client/app/hooks/data/githubLake';

/**
 * The connect/status control for every external source an EXISTING lake can take, from the
 * lakeSources registry. A lake is fed by one connector (resolveConnectableLake 409s a second), so
 * once a source is connected only that one is shown; until then every available source offers its
 * connect panel. Unavailable sources are omitted here - ConnectSourceMenu is where they are explained.
 */
export default function LakeSourceConnectActions({ lake }: { lake: LakeSourceLake & { id: string } }) {
  const available = useOfferedLakeSources(lake)
    .filter(({ availability }) => availability.status === 'available')
    .map(({ source }) => source);
  const isAvailable = (kind: LakeSourceKind) => available.some(source => source.kind === kind);

  // Shared query keys with the panels, so these reads are deduped rather than doubled. A source that
  // is not available never fires its read: GitHub's routes 403 with the flag off.
  const { data: driveConnection } = useLakeDriveConnection(lake.id, isAvailable('googleDrive'));
  const { data: gitHubConnection } = useLakeGitHubConnection(lake.id, isAvailable('github'));
  const connected: Record<LakeSourceKind, boolean> = { googleDrive: !!driveConnection, github: !!gitHubConnection };

  // Only available sources count, so stale cache from a flagged-off source cannot hide the others.
  const connectedSource = available.find(source => connected[source.kind]);
  const shown = connectedSource ? [connectedSource] : available;

  return (
    <Stack gap={1} data-testid="lake-source-connect-actions">
      {shown.map(({ kind, Panel }) => (
        <Panel key={kind} lake={lake} />
      ))}
    </Stack>
  );
}
