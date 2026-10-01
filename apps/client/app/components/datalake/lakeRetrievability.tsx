import { Tooltip } from '@mui/joy';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import type { ISession, ManageableDataLakeConfig } from '@bike4mind/common';

export const UNSEARCHABLE_LAKE_REASON =
  'Chat can not search this lake with your current access. You can still browse it.';

export type SessionAdmissionView = Pick<ISession, 'preauthorizedLakeIds' | 'userId'>;

/**
 * Whether chat retrieval will skip this lake for the viewer. Only an explicit `retrievable === false`
 * from GET /api/data-lakes marks it (absent = unknown, treated as searchable). The server label is
 * session-agnostic, so a session pre-authorization exempts the lake, but only where chat honours it:
 * the viewer owns the session (vetPreauthorizedLakeIds) and can still pre-authorize the lake
 * (filterStillManagedLakes in unionPreauthorizedLakeAccess), and the lake is active.
 */
export function isUnsearchable(
  lake: Pick<ManageableDataLakeConfig, 'id' | 'retrievable' | 'status' | 'canPreauthorize'>,
  session?: SessionAdmissionView | null,
  viewerUserId?: string
): boolean {
  if (lake.retrievable !== false) return false;
  const admitted =
    !!viewerUserId &&
    session?.userId === viewerUserId &&
    lake.canPreauthorize === true &&
    lake.status === 'active' &&
    !!session.preauthorizedLakeIds?.includes(lake.id);
  return !admitted;
}

export function UnsearchableLakeIcon({ testId }: { testId: string }) {
  return (
    <Tooltip size="sm" title={UNSEARCHABLE_LAKE_REASON}>
      <SearchOffIcon data-testid={testId} sx={{ fontSize: 14, color: 'warning.400', flexShrink: 0 }} />
    </Tooltip>
  );
}
