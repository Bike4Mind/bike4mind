import { Tooltip } from '@mui/joy';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import type { RetrievabilityLabeledDataLake } from '@bike4mind/common';
import { DRAFT_LAKE_TOOLTIP, isDraftLake } from './lakeVisibility';

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

type ReasonLake = Parameters<typeof isDraftLake>[0];

/** A draft reads false for its own owner too, so blaming access there would send them the wrong way. */
export function unsearchableLakeReason(lake: ReasonLake): string {
  return isDraftLake(lake) ? DRAFT_LAKE_TOOLTIP : UNSEARCHABLE_LAKE_REASON;
}

export function UnsearchableLakeIcon({ lake, testId }: { lake: ReasonLake; testId: string }) {
  const reason = unsearchableLakeReason(lake);
  return (
    <Tooltip size="sm" title={reason}>
      <SearchOffIcon
        data-testid={testId}
        role="img"
        aria-hidden={false}
        aria-label={reason}
        sx={{ fontSize: 14, color: 'warning.400', flexShrink: 0 }}
      />
    </Tooltip>
  );
}
