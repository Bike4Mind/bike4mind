import type { RecordShadowDetectionInput } from '@bike4mind/database';
import {
  ADMIN_GATE_PATHS,
  BREADTH_GATE_PATHS,
  PROBE_SIGNAL_LABELS,
  SIGNAL_WEIGHTS,
  type ProbeActor,
  type ProbeSignal,
} from './apiProbeScoring';

/**
 * Shadow detection for an actor the API probe detector reports (contract in shadowDetection.ts in
 * @bike4mind/common). Recording it puts the actor in front of the abuse assessment sweep and, through
 * its verdict, automated containment (apps/client/server/security/autoContainment), whose own gates
 * (mode, confidence, hourly cap, cohort size) decide whether anything happens. Recording never
 * touches an account.
 */

/**
 * v1: the accounts that reach the threshold on their own rows would be contained. Linked accounts
 * below it (a co-tenant on a shared IP) are left out, and an actor with no such account is not
 * recorded: there is no account to contain, and nothing acts on an IP. Bump when this mapping
 * changes, so precision is measured per policy.
 */
export const API_PROBE_POLICY_VERSION = 1;

/** The count from which a signal starts scoring; null for signals that score from the first one. */
const SIGNAL_GATES: Partial<Record<ProbeSignal, number>> = {
  adminDenied: ADMIN_GATE_PATHS,
  denied: BREADTH_GATE_PATHS,
  notFound: BREADTH_GATE_PATHS,
};

export function buildApiProbeShadowDetection(input: {
  actor: ProbeActor;
  threshold: number;
  window: { start: Date; end: Date };
}): RecordShadowDetectionInput | null {
  const { actor, threshold, window } = input;
  const userIds = actor.userIds.filter(userId => (actor.userScores[userId] ?? 0) >= threshold);
  if (userIds.length === 0) return null;
  const windowMinutes = Math.round((window.end.getTime() - window.start.getTime()) / 60_000);
  const signals = (Object.keys(PROBE_SIGNAL_LABELS) as ProbeSignal[])
    .filter(signal => actor.counts[signal] > 0)
    .map(signal => ({
      key: signal,
      label: `${PROBE_SIGNAL_LABELS[signal]} (weight ${SIGNAL_WEIGHTS[signal]})`,
      observed: actor.counts[signal],
      threshold: SIGNAL_GATES[signal] ?? null,
    }));
  return {
    detector: 'apiProbe',
    policyVersion: API_PROBE_POLICY_VERSION,
    wouldAction: 'contain',
    summary:
      `API probe score ${actor.score} in ${windowMinutes} minutes from ${actor.ips.length} IP(s); ` +
      `${userIds.length} of ${actor.userIds.length} linked account(s) scored the threshold on their own, ` +
      `~${actor.distinctPaths} distinct failing paths`,
    userIds,
    network:
      actor.ips.length === 1 ? { ip: actor.ips[0], asn: null, asnOrg: null, country: null, hosting: null } : null,
    signals: [
      { key: 'score', label: 'Probe score', observed: actor.score, threshold },
      { key: 'ipCount', label: 'Distinct client IPs', observed: actor.ips.length, threshold: null },
      { key: 'linkedAccounts', label: 'Linked accounts', observed: actor.userIds.length, threshold: null },
      ...signals,
    ],
    windowMinutes,
    group: null,
    payment: null,
    detectedAt: window.end,
  };
}
