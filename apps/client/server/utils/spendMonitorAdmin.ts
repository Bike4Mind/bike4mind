import {
  SPEND_BUCKET_MS,
  SPEND_FREEZE_SCOPE_TYPES,
  type SpendAlertAutoPause,
  type SpendAlertRecord,
  type SpendAutoPauseMode,
  type SpendFreezeScope,
} from '@bike4mind/common';
import { labelFreezes, labelKey } from './spendFreezeAdmin';

/** An incident as the Spend monitor page receives it: dates are ISO strings over JSON. */
export type SpendIncidentRow = Omit<SpendAlertRecord, 'openedAt' | 'autoPause'> & {
  openedAt: string;
  autoPause?: Omit<SpendAlertAutoPause, 'decidedAt'> & { decidedAt: string };
  /** Email, organization name or key prefix; null for scopes without one. */
  label: string | null;
};

export type SpendMonitorOverview = {
  incidents: SpendIncidentRow[];
  platform: { lastHourCredits: number; last24hCredits: number; latestBucketStart: string | null };
  autoPause: {
    mode: SpendAutoPauseMode;
    minCreditsByTier: { standard: number; paid: number; trusted: number };
  };
};

const SEVERITY_RANK: Record<SpendAlertRecord['severity'], number> = { critical: 0, warning: 1 };

/** Critical first, then newest first. */
export const sortIncidents = <T extends Pick<SpendAlertRecord, 'severity' | 'openedAt'>>(incidents: T[]): T[] =>
  [...incidents].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.openedAt.getTime() - a.openedAt.getTime()
  );

const FREEZABLE_SCOPE_TYPES: readonly string[] = SPEND_FREEZE_SCOPE_TYPES;

const isFreezableScope = <T extends Pick<SpendAlertRecord, 'scopeType' | 'scopeId'>>(
  incident: T
): incident is T & SpendFreezeScope => FREEZABLE_SCOPE_TYPES.includes(incident.scopeType);

/** Adds the account label to each incident whose scope is a user, organization or API key. */
export const labelIncidents = async (incidents: SpendAlertRecord[]): Promise<SpendIncidentRow[]> => {
  const labels = await labelFreezes(incidents.filter(isFreezableScope));
  return incidents.map(incident => ({
    ...incident,
    openedAt: incident.openedAt.toISOString(),
    autoPause: incident.autoPause
      ? { ...incident.autoPause, decidedAt: incident.autoPause.decidedAt.toISOString() }
      : undefined,
    label: isFreezableScope(incident) ? (labels.get(labelKey(incident)) ?? null) : null,
  }));
};

/** The end of the newest rolled bucket, so the sums cover whole buckets the monitor has actually written. */
export const platformWindowEnd = (latestBucketStart: Date | null, now: Date): Date =>
  latestBucketStart ? new Date(latestBucketStart.getTime() + SPEND_BUCKET_MS) : now;
