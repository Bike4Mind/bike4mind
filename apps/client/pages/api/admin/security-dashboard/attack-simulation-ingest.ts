import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import {
  securityFindingRepository,
  securityFindingRunRepository,
  type ISecurityFindingDocument,
  type SecurityFindingCategory,
  type SecurityFindingSeverity,
} from '@bike4mind/database';
import { Resource } from 'sst';
import { isPlaceholderValue } from '@bike4mind/common';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import { resolveStage } from '@server/security/resolveStage';
import { Logger } from '@bike4mind/observability';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import type { AttackSimulationFinding, AttackSimulationIngestPayload } from '@server/security/attackSimulation/types';

const logger = new Logger({ metadata: { service: 'attack-simulation-ingest' } });
const sqsClient = new SQSClient({});

// Map Active Defense P0-P3 severities to SecOps Triage's critical/high/medium/low scale.
// SecOps Triage's worker, GitHub-issue creator, LLM enricher, and auto-close logic are all
// keyed on the lowercase ZAP-style severity vocabulary - preserve that contract by mapping
// at the boundary rather than fanning out a new severity space.
const SEVERITY_TO_TRIAGE: Record<SecurityFindingSeverity, 'critical' | 'high' | 'medium' | 'low'> = {
  P0: 'critical',
  P1: 'high',
  P2: 'medium',
  P3: 'low',
};

// SQS message body cap is 256 KB. Findings are validated at ingest with
// MAX_STRING_LENGTH = 4000, which in the worst case (200 findings x ~9.5 KB)
// would blow past the SQS limit, so we truncate per-field at the publish
// boundary to guarantee the payload fits regardless of probe-author drift.
//
// Budget: ~512 (id+title+endpoint) + 1000 (description) + 1000 (recommendation)
// + JSON overhead ~= 4 KB per finding. With MAX_FINDINGS=200 that's ~800 KB worst
// case - still above SQS limit, but realistic runs (~30 findings) yield ~120 KB,
// well under the limit.
const SQS_FIELD_CAP = 1000;
const truncateForSqs = (value: string): string =>
  value.length > SQS_FIELD_CAP ? `${value.slice(0, SQS_FIELD_CAP)}… [truncated]` : value;

const VALID_CATEGORIES: SecurityFindingCategory[] = ['auth', 'injection', 'authz', 'config', 'code-absence', 'misc'];
const VALID_SEVERITIES: SecurityFindingSeverity[] = ['P0', 'P1', 'P2', 'P3'];

const STAGE_PATTERN = /^[a-z0-9-]+$/i;

// Caps to prevent oversized payloads from blowing up the upsert loop or storage. Probes
// will never legitimately produce more than ~30 findings; 200 is a comfortable ceiling.
const MAX_FINDINGS = 200;
const MAX_STRING_LENGTH = 4000;
const MAX_PROBES_RUN = 50;
const MAX_PROBE_ERRORS = 50;

function isValidString(value: unknown, max = MAX_STRING_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isValidFinding(input: unknown): input is AttackSimulationFinding {
  if (!input || typeof input !== 'object') return false;
  const f = input as Record<string, unknown>;
  return (
    isValidString(f.fingerprint, 512) &&
    typeof f.category === 'string' &&
    VALID_CATEGORIES.includes(f.category as SecurityFindingCategory) &&
    typeof f.severity === 'string' &&
    VALID_SEVERITIES.includes(f.severity as SecurityFindingSeverity) &&
    isValidString(f.endpoint, 512) &&
    isValidString(f.title, 512) &&
    isValidString(f.details) &&
    isValidString(f.reproduction) &&
    // sourceProbe is set by the runner; tolerate absence for direct ingests (tests).
    (f.sourceProbe === undefined || isValidString(f.sourceProbe, 128))
  );
}

function isValidTargetUrl(value: unknown): value is string {
  if (!isValidString(value, 2048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const handler = baseApi<Request, Response>({ auth: false }).post(async (req: Request, res: Response) => {
  const ingestToken =
    Resource.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN?.value || process.env.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN;

  if (!ingestToken || isPlaceholderValue(ingestToken)) {
    return res.status(500).json({ error: 'Attack simulation ingest token is not configured.' });
  }

  const providedTokenHeader = req.headers['x-security-ingest-token'];
  const providedToken = Array.isArray(providedTokenHeader) ? providedTokenHeader[0] : providedTokenHeader;
  if (!providedToken || !safeCompareTokens(String(providedToken), ingestToken)) {
    return res.status(403).json({ error: 'Invalid ingest token.' });
  }

  const body = req.body as Partial<AttackSimulationIngestPayload> | undefined;
  const {
    runId,
    stage: rawStage,
    trigger,
    targetUrl,
    startedAt,
    finishedAt,
    probesRun,
    probeErrors,
    findings,
  } = body || {};

  if (!isValidString(runId, 128)) {
    return res.status(400).json({ error: 'Invalid payload: runId is required.' });
  }
  if (trigger !== 'manual' && trigger !== 'scheduled') {
    return res.status(400).json({ error: 'Invalid payload: trigger must be "manual" or "scheduled".' });
  }
  if (!isValidTargetUrl(targetUrl)) {
    return res.status(400).json({ error: 'Invalid payload: targetUrl must be a valid http(s) URL.' });
  }
  if (!Array.isArray(findings)) {
    return res.status(400).json({ error: 'Invalid payload: findings must be an array.' });
  }
  if (findings.length > MAX_FINDINGS) {
    return res.status(400).json({ error: `Invalid payload: findings exceeds limit of ${MAX_FINDINGS}.` });
  }
  if (!Array.isArray(probesRun) || probesRun.length > MAX_PROBES_RUN || !probesRun.every(p => isValidString(p, 128))) {
    return res.status(400).json({ error: 'Invalid payload: probesRun must be an array of probe names.' });
  }
  const safeProbeErrors = Array.isArray(probeErrors)
    ? probeErrors.slice(0, MAX_PROBE_ERRORS).filter((e): e is string => isValidString(e))
    : [];
  if (!findings.every(isValidFinding)) {
    return res.status(400).json({ error: 'Invalid payload: one or more findings are malformed.' });
  }

  const rawStageValue = rawStage || resolveStage();
  if (!STAGE_PATTERN.test(rawStageValue)) {
    return res.status(400).json({ error: 'Invalid stage value.' });
  }
  const stage = rawStageValue;

  const now = new Date();
  const lastSeenAt = finishedAt && !Number.isNaN(Date.parse(finishedAt)) ? new Date(finishedAt) : now;
  const runStartedAt = startedAt && !Number.isNaN(Date.parse(startedAt)) ? new Date(startedAt) : now;

  // Bulk upsert collapses N sequential round-trips into a single bulkWrite + a follow-up
  // fetch. The fetched documents are what we publish to secopsTriageQueue below - the
  // SecOps Triage worker handles GitHub-issue creation, dedup, and auto-close downstream.
  // Default sourceProbe to a synthetic 'direct-ingest' value when missing so the
  // resolution sweep can still scope correctly.
  const upsertInputs = findings.map(finding => ({
    fingerprint: finding.fingerprint,
    stage,
    category: finding.category,
    severity: finding.severity,
    endpoint: finding.endpoint,
    title: finding.title,
    details: finding.details,
    reproduction: finding.reproduction,
    sourceProbe: finding.sourceProbe ?? 'direct-ingest',
    lastSeenAt,
    runId,
  }));

  let persistedFindings: ISecurityFindingDocument[] = [];
  let newCount = 0;
  let persistingCount = 0;
  try {
    const bulk = await securityFindingRepository.bulkUpsertByFingerprint(upsertInputs);
    persistedFindings = bulk.findings;
    newCount = bulk.newCount;
    persistingCount = bulk.persistingCount;
  } catch (err) {
    logger.error('attack-simulation-ingest: bulk upsert failed', {
      error: err instanceof Error ? err.message : String(err),
      findingCount: upsertInputs.length,
    });
    return res.status(500).json({ error: 'Failed to persist findings.' });
  }

  // Only resolve findings whose sourceProbe is in the set that actually executed this run.
  // A partial run (some probes failed) must not auto-resolve findings owned by probes that
  // never produced a result.
  const resolvedCount = await securityFindingRepository.markMissingAsResolved(stage, runId, probesRun);

  const findingCounts = { new: newCount, persisting: persistingCount, resolved: resolvedCount };

  // Upsert the run record. The Lambda runner creates a 'running' run before invoking probes;
  // this endpoint completes it. If no run exists yet (direct ingest, e.g. from tests), create one.
  const existingRun = await securityFindingRunRepository.findByRunId(runId);
  if (existingRun) {
    await securityFindingRunRepository.completeRun(runId, findingCounts, probesRun, safeProbeErrors);
  } else {
    await securityFindingRunRepository.create({
      runId,
      stage,
      targetUrl,
      trigger,
      startedAt: runStartedAt,
      finishedAt: lastSeenAt,
      status: 'completed',
      findingCounts,
      probesRun,
      probeErrors: safeProbeErrors,
    });
  }

  logger.info('attack-simulation-ingest: run recorded', {
    runId,
    stage,
    trigger,
    findingCounts,
    probeErrorCount: safeProbeErrors.length,
  });

  // Fan out to the SecOps Triage SQS queue - the worker (long-running Lambda) handles
  // GitHub issue creation, fingerprint dedup, auto-close on resolution, and optional LLM
  // enrichment. Active Defense joins the same triage pipeline as ZAP / Packages / Semgrep /
  // Secrets / Cloud findings so there is one operational surface, not a parallel one.
  //
  // Non-fatal: a failed publish must not break the ingest 201 response. Findings are already
  // persisted to MongoDB; a missed SQS publish only loses the GitHub-issue side effect.
  if (persistedFindings.length > 0) {
    try {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: getSourceQueueUrl('secopsTriageQueue'),
          MessageBody: JSON.stringify({
            stage,
            scanSource: 'active-defense' as const,
            snapshotId: runId,
            targetUrl,
            findings: persistedFindings.map(f => ({
              id: f.fingerprint,
              title: f.title,
              severity: SEVERITY_TO_TRIAGE[f.severity],
              description: truncateForSqs(f.details),
              recommendation: truncateForSqs(f.reproduction),
              instances: [{ uri: f.endpoint }],
            })),
          }),
        })
      );
      logger.info('SecOps Triage: published Active Defense findings to SQS', {
        stage,
        runId,
        findingCount: persistedFindings.length,
      });
    } catch (err) {
      logger.error('SecOps Triage: failed to publish Active Defense findings to SQS (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return res.status(201).json({
    runId,
    stage,
    findingCounts,
    findings: persistedFindings,
  });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
