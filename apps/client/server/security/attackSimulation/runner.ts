/**
 * Attack Simulation Runner
 *
 * Executes 7 HTTP probes against the deployment's own URL and POSTs the findings to the
 * attack-simulation-ingest endpoint. Designed to run inside the deployment as a Lambda -
 * either invoked on-demand via the admin "Run Now" endpoint or on a weekly cron schedule.
 *
 * The runner never persists findings itself; it always goes through the ingest endpoint
 * so that ingest auth, validation, and dedup logic stays in one place.
 */

import { randomUUID } from 'crypto';
import { Context } from 'aws-lambda';
import { Resource } from 'sst';
import { Logger } from '@bike4mind/observability';
import { connectDB, securityFindingRunRepository } from '@bike4mind/database';
import { isPlaceholderValue } from '@bike4mind/common';
import { Config } from '@server/utils/config';
import { resolveStage } from '@server/security/resolveStage';
import { getTargetUrlForStage } from '@server/integrations/github/githubWorkflowTrigger';
import { e2eExposureProbe } from './probes/e2eExposure';
import { otcSendFloodProbe } from './probes/otcSendFlood';
import { refreshTokenSecurityProbe } from './probes/refreshTokenSecurity';
import { adminAuthzProbe } from './probes/adminAuthz';
import { openRedirectProbe } from './probes/openRedirect';
import { ingestTokenSecurityProbe } from './probes/ingestTokenSecurity';
import { assertTargetUrlIsSafe } from './probes/probeUtils';
import type { AttackSimulationFinding, AttackSimulationIngestPayload } from './types';

const logger = new Logger({ metadata: { service: 'attack-simulation-runner' } });

// A run is considered abandoned (and reaped) after this many ms. Must exceed the Lambda's
// 14-minute timeout so a legitimately-running run is never reaped while in flight.
const STALE_RUN_AFTER_MS = 20 * 60 * 1000;

interface RunnerEvent {
  runId?: string;
  trigger?: 'manual' | 'scheduled';
  targetUrlOverride?: string;
}

interface RunnerResult {
  runId: string;
  stage: string;
  targetUrl: string;
  trigger: 'manual' | 'scheduled';
  findingCount: number;
  errors: string[];
  skipped?: boolean;
  skipReason?: string;
}

export const handler = async (event: RunnerEvent = {}, _context?: Context): Promise<RunnerResult> => {
  const stage = resolveStage();
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage), logger);
  const targetUrl = event.targetUrlOverride || getTargetUrlForStage(stage);

  // Defense-in-depth: validate the target URL before any DB write or HTTP call. Probes
  // re-validate internally, but we also use this URL to build the ingest endpoint URL -
  // a malicious target could otherwise exfiltrate the ingest token.
  try {
    assertTargetUrlIsSafe(targetUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('attack-simulation-runner: refusing to run against unsafe target', {
      targetUrl,
      error: message,
    });
    return {
      runId: event.runId || 'rejected',
      stage,
      targetUrl,
      trigger: event.trigger || 'scheduled',
      findingCount: 0,
      errors: [message],
      skipped: true,
      skipReason: 'unsafe-target-url',
    };
  }

  const trigger = event.trigger || 'scheduled';

  // Single-flight guard: reap any stale runs first, then check for an in-flight run for this
  // stage. If found, skip rather than launch a duplicate that would race the active run's
  // resolution sweep.
  const reapedCount = await securityFindingRunRepository.reapStaleRuns(stage, STALE_RUN_AFTER_MS);
  if (reapedCount > 0) {
    logger.warn('attack-simulation-runner: reaped stale runs before starting', { stage, reapedCount });
  }

  const activeRun = await securityFindingRunRepository.findActiveRun(stage, STALE_RUN_AFTER_MS);
  if (activeRun) {
    logger.warn('attack-simulation-runner: another run is in flight; skipping', {
      stage,
      activeRunId: activeRun.runId,
    });
    return {
      runId: activeRun.runId,
      stage,
      targetUrl,
      trigger,
      findingCount: 0,
      errors: [],
      skipped: true,
      skipReason: 'another-run-in-flight',
    };
  }

  const runId = event.runId || randomUUID();
  const startedAt = new Date();

  logger.info('attack-simulation-runner: starting', { runId, stage, targetUrl, trigger });

  await securityFindingRunRepository.create({
    runId,
    stage,
    targetUrl,
    trigger,
    startedAt,
    status: 'running',
    findingCounts: { new: 0, persisting: 0, resolved: 0 },
    probesRun: [],
    probeErrors: [],
  });

  const probes = [
    { name: 'e2eExposure', run: () => e2eExposureProbe(targetUrl, stage) },
    { name: 'otcSendFlood', run: () => otcSendFloodProbe(targetUrl) },
    { name: 'refreshTokenSecurity', run: () => refreshTokenSecurityProbe(targetUrl) },
    { name: 'adminAuthz', run: () => adminAuthzProbe(targetUrl) },
    { name: 'openRedirect', run: () => openRedirectProbe(targetUrl) },
    { name: 'ingestTokenSecurity', run: () => ingestTokenSecurityProbe(targetUrl) },
  ];

  const allFindings: AttackSimulationFinding[] = [];
  const probesRun: string[] = [];
  const probeErrors: string[] = [];

  for (const probe of probes) {
    try {
      const result = await probe.run();
      probesRun.push(probe.name);
      // Stamp each finding with the probe that surfaced it so the ingest can scope the
      // missing-finding resolution sweep to probes that actually executed in this run.
      for (const finding of result.findings) {
        allFindings.push({ ...finding, sourceProbe: probe.name });
      }
      if (result.error) {
        probeErrors.push(`${probe.name}: ${result.error}`);
      }
      logger.info('attack-simulation-runner: probe complete', {
        probe: probe.name,
        findingCount: result.findings.length,
        error: result.error,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      probeErrors.push(`${probe.name}: ${message}`);
      logger.error('attack-simulation-runner: probe threw', { probe: probe.name, error: message });
    }
  }

  const finishedAt = new Date();

  const ingestToken =
    Resource.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN?.value || process.env.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN;

  if (!ingestToken || isPlaceholderValue(ingestToken)) {
    const message = 'Attack simulation ingest token is not configured.';
    await securityFindingRunRepository.failRun(runId, message);
    logger.error('attack-simulation-runner: ingest token missing', { runId });
    return {
      runId,
      stage,
      targetUrl,
      trigger,
      findingCount: allFindings.length,
      errors: [...probeErrors, message],
    };
  }

  const payload: AttackSimulationIngestPayload = {
    runId,
    stage,
    trigger,
    targetUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    probesRun,
    probeErrors,
    findings: allFindings,
  };

  try {
    const ingestUrl = `${targetUrl.replace(/\/$/, '')}/api/admin/security-dashboard/attack-simulation-ingest`;
    const response = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-security-ingest-token': ingestToken,
      },
      body: JSON.stringify(payload),
      // Manual redirect - never follow a 30x with the ingest token attached.
      redirect: 'manual',
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ingest returned ${response.status}: ${body.slice(0, 200)}`);
    }
    logger.info('attack-simulation-runner: ingest succeeded', { runId, findingCount: allFindings.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await securityFindingRunRepository.failRun(runId, message);
    logger.error('attack-simulation-runner: ingest failed', { runId, error: message });
    return {
      runId,
      stage,
      targetUrl,
      trigger,
      findingCount: allFindings.length,
      errors: [...probeErrors, message],
    };
  }

  return { runId, stage, targetUrl, trigger, findingCount: allFindings.length, errors: probeErrors };
};
