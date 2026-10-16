import type { SecurityFindingCategory, SecurityFindingSeverity } from '@bike4mind/database';

/**
 * Result emitted by an attack probe. The runner persists these via the ingest endpoint.
 *
 * Fingerprint must be deterministic across runs - derive it from category, endpoint, and title.
 * Do not include timestamps, counts, runIds, or other volatile data. To distinguish two
 * near-identical findings, vary the endpoint or category, not the title alone.
 *
 * `sourceProbe` is set by the runner from the probe's exported name and used to scope
 * auto-resolution of missing findings to runs whose probe set actually executed.
 */
export interface AttackSimulationFinding {
  fingerprint: string;
  category: SecurityFindingCategory;
  severity: SecurityFindingSeverity;
  endpoint: string;
  title: string;
  details: string;
  reproduction: string;
  sourceProbe?: string;
}

export interface AttackSimulationProbeResult {
  probeName: string;
  findings: AttackSimulationFinding[];
  error?: string;
}

export interface AttackSimulationIngestPayload {
  runId: string;
  stage?: string;
  trigger: 'manual' | 'scheduled';
  targetUrl: string;
  startedAt: string;
  finishedAt: string;
  probesRun: string[];
  probeErrors?: string[];
  findings: AttackSimulationFinding[];
}
