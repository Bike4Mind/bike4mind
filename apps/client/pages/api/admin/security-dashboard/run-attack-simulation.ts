import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { Resource } from 'sst';
import { randomUUID } from 'crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Logger } from '@bike4mind/observability';
import { securityFindingRunRepository } from '@bike4mind/database';
import { getCooldownStatus } from '@server/security/cooldown';
import { logAuditEvent, AdminConfigAuditEvents } from '@server/utils/auditLog';

const logger = new Logger({ metadata: { service: 'run-attack-simulation' } });

const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between manual runs

/**
 * Admin endpoint - POST to trigger an Attack Simulation run on demand.
 * Invokes the attackSimulationFunction Lambda asynchronously and returns immediately
 * with the runId so the UI can poll for results.
 */
const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const stage = Resource.App.stage;

  // Cooldown is computed against the last *terminal* run (completed or failed) rather than
  // any recent run - so a stuck `running` doc from a prior failure does not lock the button.
  // Anchor on `finishedAt` so the 30-minute window starts when the run ends; prior to that
  // (during execution) the in-flight run itself blocks duplicates via the runner's
  // single-flight guard. Falls back to `startedAt` if `finishedAt` is missing (legacy data).
  const lastTerminal = await securityFindingRunRepository.findLastTerminalRun(stage);
  const cooldownAnchor = lastTerminal?.finishedAt ?? lastTerminal?.startedAt;
  const cooldown = getCooldownStatus(cooldownAnchor, COOLDOWN_MS);
  if (!cooldown.canRun) {
    const minutesRemaining = Math.max(1, Math.ceil(cooldown.remainingMs / 60_000));
    throw new BadRequestError(`Attack simulation cooldown active — try again in ${minutesRemaining} minute(s).`);
  }

  const runId = randomUUID();
  const client = new LambdaClient({});
  // Linkable-injected - avoids per-resource IAM statement bloat. Wildcard
  // `lambda:InvokeFunction` permission on the frontend Lambda grants invocation access.
  const functionName = Resource.lambdaFunctionNames?.attackSimulation;

  if (!functionName) {
    logger.error('run-attack-simulation: attackSimulationFunction not linked');
    return res.status(500).json({ error: 'Attack simulation function is not configured.' });
  }

  await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ runId, trigger: 'manual' })),
    })
  );

  await logAuditEvent(
    {
      userId: req.user?.id ?? 'unknown',
      action: AdminConfigAuditEvents.SECURITY_SCAN_SCHEDULE_TRIGGERED,
      metadata: {
        scanType: 'attack-simulation',
        stage,
        runId,
        trigger: 'manual',
      },
    },
    req.logger
  );

  logger.info('run-attack-simulation: invoked', { runId, stage, userId: req.user?.id });

  return res.status(202).json({ queued: true, runId });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
