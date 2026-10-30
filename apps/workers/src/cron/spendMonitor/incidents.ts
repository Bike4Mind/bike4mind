import { spendAlertOpenKey, type ISpendAlert, type SpendAlertRecord, type SpendAlertSeverity } from '@bike4mind/common';
import type { SpendBreach } from './rules';

/** Every patch stamps the window it came from, which is what makes a retried run a no-op. */
export type IncidentPatch = Partial<ISpendAlert> & { lastEvaluatedWindowEnd: Date };

export type IncidentDecision =
  | { kind: 'open'; alert: ISpendAlert }
  | { kind: 'escalate'; id: string; patch: IncidentPatch }
  | { kind: 'update'; id: string; patch: IncidentPatch }
  | { kind: 'resolve'; id: string; patch: IncidentPatch };

/** Consecutive runs with no breach before an incident resolves. */
const CLEAR_RUNS_TO_RESOLVE = 2;

/** Growth of the value since the last notification that earns a fresh post. */
const ESCALATION_MULTIPLE = 2;

const SEVERITY_RANK: Record<SpendAlertSeverity, number> = { warning: 0, critical: 1 };

const higherSeverity = (a: SpendAlertSeverity, b: SpendAlertSeverity): SpendAlertSeverity =>
  SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;

function decideForBreach(alert: SpendAlertRecord, breach: SpendBreach, windowEnd: Date): IncidentDecision {
  const patch: IncidentPatch = {
    lastValue: breach.value,
    peakValue: Math.max(alert.peakValue, breach.value),
    clearRuns: 0,
    lastEvaluatedWindowEnd: windowEnd,
    context: { baseline: breach.baseline, ratio: breach.ratio },
  };
  const severityRose = SEVERITY_RANK[breach.severity] > SEVERITY_RANK[alert.severity];
  // lastNotifiedValue is undefined after a failed post, so 2 * 0 <= value re-notifies on the next run.
  const grewEnough = breach.value >= ESCALATION_MULTIPLE * (alert.lastNotifiedValue ?? 0);
  const escalates = alert.status === 'acknowledged' ? severityRose : severityRose || grewEnough;

  if (!escalates) return { kind: 'update', id: alert.id, patch };
  return {
    kind: 'escalate',
    id: alert.id,
    patch: { ...patch, severity: higherSeverity(alert.severity, breach.severity) },
  };
}

function decideForClearRun(alert: SpendAlertRecord, now: Date, windowEnd: Date): IncidentDecision {
  const clearRuns = alert.clearRuns + 1;
  if (clearRuns < CLEAR_RUNS_TO_RESOLVE) {
    return { kind: 'update', id: alert.id, patch: { clearRuns, lastEvaluatedWindowEnd: windowEnd } };
  }
  return {
    kind: 'resolve',
    id: alert.id,
    patch: { status: 'resolved', resolvedAt: now, clearRuns, lastEvaluatedWindowEnd: windowEnd },
  };
}

const alreadyEvaluated = (alert: SpendAlertRecord, windowEnd: Date): boolean =>
  alert.lastEvaluatedWindowEnd !== undefined && alert.lastEvaluatedWindowEnd.getTime() >= windowEnd.getTime();

/**
 * Pure transition of the active incidents given the breaches of the window ending at `windowEnd`. An
 * incident already evaluated for that window is skipped (a Lambda retry or an overlapping run), but
 * still blocks a duplicate open. A resolve patch does not clear openKey: the caller must also unset it
 * so the key frees up for the next incident.
 */
export function decideIncidents(
  active: SpendAlertRecord[],
  breaches: SpendBreach[],
  now: Date,
  windowEnd: Date
): IncidentDecision[] {
  const breachesByKey = new Map(breaches.map(b => [spendAlertOpenKey(b.rule, b.scopeType, b.scopeId), b]));
  const decisions: IncidentDecision[] = [];
  const activeKeys = new Set<string>();

  for (const alert of active) {
    const key = alert.openKey ?? spendAlertOpenKey(alert.rule, alert.scopeType, alert.scopeId);
    activeKeys.add(key);
    if (alreadyEvaluated(alert, windowEnd)) continue;
    const breach = breachesByKey.get(key);
    decisions.push(breach ? decideForBreach(alert, breach, windowEnd) : decideForClearRun(alert, now, windowEnd));
  }

  for (const [key, breach] of breachesByKey) {
    if (activeKeys.has(key)) continue;
    decisions.push({
      kind: 'open',
      alert: {
        rule: breach.rule,
        scopeType: breach.scopeType,
        scopeId: breach.scopeId,
        openKey: key,
        status: 'open',
        severity: breach.severity,
        openedAt: now,
        peakValue: breach.value,
        lastValue: breach.value,
        clearRuns: 0,
        lastEvaluatedWindowEnd: windowEnd,
        context: { baseline: breach.baseline, ratio: breach.ratio },
      },
    });
  }

  return decisions;
}
