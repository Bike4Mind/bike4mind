import { Tooltip } from '@mui/joy';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import type { RetrievabilityLabeledDataLake } from '@bike4mind/common';

export const UNSEARCHABLE_LAKE_REASON =
  'Chat can not search this lake with your current access. You can still browse it.';

/** Reads the server's `retrievable` label (contract: DataLakeRetrievabilityLabel); no client-side admission logic. */
export function isUnsearchable(lake: Pick<RetrievabilityLabeledDataLake, 'id' | 'retrievable'>): boolean {
  return lake.retrievable === false;
}

/**
 * For a lake picked into a NEW test session, which session-create will pre-authorize exactly when
 * the server labelled the row `canPreauthorize`. No session id exists yet to ask the server about.
 */
export function isUnsearchableInNewTestSession(
  lake: Pick<RetrievabilityLabeledDataLake, 'id' | 'retrievable' | 'canPreauthorize'>
): boolean {
  return isUnsearchable(lake) && !lake.canPreauthorize;
}

export function UnsearchableLakeIcon({ testId }: { testId: string }) {
  return (
    <Tooltip size="sm" title={UNSEARCHABLE_LAKE_REASON}>
      <SearchOffIcon data-testid={testId} sx={{ fontSize: 14, color: 'warning.400', flexShrink: 0 }} />
    </Tooltip>
  );
}
