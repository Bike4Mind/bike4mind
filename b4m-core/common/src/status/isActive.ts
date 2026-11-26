export const INCIDENT_KINDS = ['incident', 'maintenance'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const MAINTENANCE_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export const ALL_INCIDENT_STATUSES = [...INCIDENT_STATUSES, ...MAINTENANCE_STATUSES] as const;
export type IncidentStatus = (typeof ALL_INCIDENT_STATUSES)[number];

type TimeValue = Date | string | number | null | undefined;

export interface ActivityFacts {
  kind: IncidentKind;
  published: boolean;
  /** Truthy when the incident was retracted. */
  retracted?: unknown;
  status: IncidentStatus;
  resolvedAt?: TimeValue;
  scheduledStartAt?: TimeValue;
  scheduledEndAt?: TimeValue;
  completedEarlyAt?: TimeValue;
  cancelledAt?: TimeValue;
}

export function toEpochMs(value: TimeValue): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function maintenanceEffectiveEndMs(
  facts: Pick<ActivityFacts, 'completedEarlyAt' | 'scheduledEndAt'>
): number | null {
  return toEpochMs(facts.completedEarlyAt) ?? toEpochMs(facts.scheduledEndAt);
}

/**
 * Incident kind: published, not retracted, not resolved. Maintenance kind: published, not retracted,
 * not cancelled, scheduledStartAt <= now < effectiveEnd. Computed from the schedule alone.
 */
export function isActive(facts: ActivityFacts, now: Date | string | number): boolean {
  if (!facts.published || facts.retracted) return false;
  const nowMs = toEpochMs(now);
  if (nowMs === null) return false;

  if (facts.kind === 'incident') {
    return facts.status !== 'resolved' && toEpochMs(facts.resolvedAt) === null;
  }

  if (facts.status === 'cancelled' || toEpochMs(facts.cancelledAt) !== null) return false;
  const start = toEpochMs(facts.scheduledStartAt);
  const end = maintenanceEffectiveEndMs(facts);
  if (start === null || end === null) return false;
  return start <= nowMs && nowMs < end;
}
