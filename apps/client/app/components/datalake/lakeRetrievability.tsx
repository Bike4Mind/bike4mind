import { Tooltip } from '@mui/joy';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import type { ISession, ManageableDataLakeConfig } from '@bike4mind/common';

export const UNSEARCHABLE_LAKE_REASON =
  'Chat can not search this lake with your current access. You can still browse it.';

/**
 * Whether chat retrieval will skip this lake for the caller. Only an explicit `retrievable === false`
 * from GET /api/data-lakes marks it (absent = unknown, treated as searchable). The server label is
 * session-agnostic, so an active lake the current session pre-authorizes is admitted here too.
 */
export function isUnsearchable(
  lake: Pick<ManageableDataLakeConfig, 'id' | 'retrievable' | 'status'>,
  session?: Pick<ISession, 'preauthorizedLakeIds'> | null
): boolean {
  if (lake.retrievable !== false) return false;
  return !(lake.status === 'active' && session?.preauthorizedLakeIds?.includes(lake.id));
}

export function UnsearchableLakeIcon({ testId }: { testId: string }) {
  return (
    <Tooltip size="sm" title={UNSEARCHABLE_LAKE_REASON}>
      <SearchOffIcon data-testid={testId} sx={{ fontSize: 14, color: 'warning.400', flexShrink: 0 }} />
    </Tooltip>
  );
}
