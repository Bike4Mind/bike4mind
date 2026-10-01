import { Tooltip } from '@mui/joy';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import type { RetrievabilityLabeledDataLake } from '@bike4mind/common';

export const UNSEARCHABLE_LAKE_REASON =
  'Chat cannot search this lake with your current access. You can still browse it.';

/** Reads the server's `retrievable` label (contract: DataLakeRetrievabilityLabel); no client-side admission logic. */
export function isUnsearchable(lake: Pick<RetrievabilityLabeledDataLake, 'retrievable'>): boolean {
  return lake.retrievable === false;
}

/**
 * Whether session-create pre-authorizes this lake when it is picked into a NEW test session. The
 * single admission rule for both the dialog's `preauthorizedLakeIds` and its unsearchable marker.
 */
export function willPreauthorizeInNewTestSession(
  lake: Pick<RetrievabilityLabeledDataLake, 'canPreauthorize'>
): boolean {
  return lake.canPreauthorize;
}

/** No session id exists yet to ask the server about, so this combines the label with the admission rule above. */
export function isUnsearchableInNewTestSession(
  lake: Pick<RetrievabilityLabeledDataLake, 'retrievable' | 'canPreauthorize'>
): boolean {
  return isUnsearchable(lake) && !willPreauthorizeInNewTestSession(lake);
}

export function UnsearchableLakeIcon({ testId }: { testId: string }) {
  return (
    <Tooltip size="sm" title={UNSEARCHABLE_LAKE_REASON}>
      <SearchOffIcon data-testid={testId} sx={{ fontSize: 14, color: 'warning.400', flexShrink: 0 }} />
    </Tooltip>
  );
}
