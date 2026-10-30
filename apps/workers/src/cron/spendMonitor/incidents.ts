import { spendAlertOpenKey, type ISpendAlert, type SpendAlertRecord, type SpendAlertSeverity } from '@bike4mind/common';
import type { SpendBreach } from './rules';

export type IncidentDecision =
  | { kind: 'open'; alert: ISpendAlert }
  | { kind: 'escalate'; id: string; patch: Partial<ISpendAlert> }
  | { kind: 'update'; id: string; patch: Partial<ISpendAlert> }
  | { kind: 'resolve'; id: string; patch: Partial<ISpendAlert> };

/** Consecutive runs with no breach before an incident resolves. */
const CLEAR_RUNS_TO_RESOLVE = 2;

/** Growth of the value since the last notification that earns a fresh post. */
const ESCALATION_MULTIPLE = 2;

const SEVERITY_RANK: Record<SpendAlertSeverity, number> = { warning: 0, critical: 1 };

const higherSeverity = (a: SpendAlertSeverity, b: SpendAlertSeverity): SpendAlertSeverity =>
  SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;

function decideForBreach(alert: SpendAlertRecord, breach: SpendBreach): IncidentDecision {
  const patch: Partial<ISpendAlert> = {
    lastValue: breach.value,
    peakValue: Math.max(alert.peakValue, breach.value),
    clearRuns: 0,
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

function decideForClearRun(alert: SpendAlertRecord, now: Date): IncidentDecision {
  const clearRuns = alert.clearRuns + 1;
  if (clearRuns < CLEAR_RUNS_TO_RESOLVE) return { kind: 'update', id: alert.id, patch: { clearRuns } };
  return { kind: 'resolve', id: alert.id, patch: { status: 'resolved', resolvedAt: now, clearRuns } };
}

/**
 * Pure transition of the active incidents given this run's breaches. A resolve patch does not clear
 * openKey: the caller must also unset it so the key frees up for the next incident.
 */
export function decideIncidents(active: SpendAlertRecord[], breaches: SpendBreach[], now: Date): IncidentDecision[] {
  const breachesByKey = new Map(breaches.map(b => [spendAlertOpenKey(b.rule, b.scopeType, b.scopeId), b]));
  const decisions: IncidentDecision[] = [];
  const activeKeys = new Set<string>();

  for (const alert of active) {
    const key = alert.openKey ?? spendAlertOpenKey(alert.rule, alert.scopeType, alert.scopeId);
    activeKeys.add(key);
    const breach = breachesByKey.get(key);
    decisions.push(breach ? decideForBreach(alert, breach) : decideForClearRun(alert, now));
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
        context: { baseline: breach.baseline, ratio: breach.ratio },
      },
    });
  }

  return decisions;
}
