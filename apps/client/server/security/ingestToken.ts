import type { Request } from 'express';
import { Resource } from 'sst';
import { isPlaceholderValue } from '@bike4mind/common';
import { safeCompareTokens } from '@bike4mind/auth/crypto';

/**
 * Logged at warn for every refused ingest token. Counted by the API probe detector
 * (apps/workers/src/cron/apiProbeScoring.ts, signal ingestTokenRefused): keep the text in sync.
 */
export const INGEST_TOKEN_REFUSED_MESSAGE = '[ingest-token-refused]';

/**
 * Sent by the scheduled attack simulation's ingest-token probe
 * (apps/workers/src/security/attackSimulation/probes/ingestTokenSecurity.ts), carrying the
 * simulation's own ingest secret, so its deliberate refusals are not counted as probing. Only a
 * caller holding that secret can set it, and it never changes whether a request is accepted.
 */
export const ATTACK_SIMULATION_HEADER = 'x-attack-simulation-token';

function linkedAttackSimulationToken(): string | undefined {
  try {
    return Resource.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN?.value;
  } catch {
    // Resource throws outside a linked SST runtime (unit tests, local scripts).
    return undefined;
  }
}

function attackSimulationToken(): string | undefined {
  const token = linkedAttackSimulationToken() || process.env.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN;
  return token && !isPlaceholderValue(token) ? token : undefined;
}

const firstHeader = (req: Request, header: string): string | undefined => {
  const raw = req.headers[header];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? String(value) : undefined;
};

function isAttackSimulation(req: Request): boolean {
  const provided = firstHeader(req, ATTACK_SIMULATION_HEADER);
  const expected = provided ? attackSimulationToken() : undefined;
  return Boolean(provided && expected && safeCompareTokens(provided, expected));
}

/**
 * True when the `header` of the request carries the expected ingest token. A refusal logs one line
 * with the request metadata (client IP, path), never the token that was sent.
 */
export function verifyIngestToken(req: Request, header: string, expected: string): boolean {
  const provided = firstHeader(req, header);
  if (provided && safeCompareTokens(provided, expected)) return true;
  if (isAttackSimulation(req)) {
    req.logger.info('ingest token refused for the attack simulation', { header });
  } else {
    req.logger.warn(INGEST_TOKEN_REFUSED_MESSAGE, { header, tokenPresent: Boolean(provided) });
  }
  return false;
}
