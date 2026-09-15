import type { AttackSimulationFinding } from '../types';
import { buildFingerprint } from '../fingerprint';
import { assertTargetUrlIsSafe, probeFetch } from './probeUtils';

const PROBE_NAME = 'e2eExposure';

const E2E_PATHS = ['/api/test/create-user', '/api/test/cleanup', '/api/test/seed'];

// Statuses that mean the endpoint is either absent or properly auth-gated - both are
// acceptable secure postures on production-like stages. 404 = doesn't exist. 401/403 =
// exists but rejects without credentials, which is the intended behavior for endpoints
// gated by E2E_CLEANUP_SECRET. The probe should only flag responses that suggest the
// endpoint accepted the request without a credential check (2xx) or behaves unexpectedly
// (e.g. 5xx leakage, 200-after-validation, etc.).
const SAFE_GATED_STATUSES = new Set([401, 403, 404]);

/**
 * Probe 2 - E2E test endpoint exposure.
 *
 * Test-only endpoints must either be absent (404) or auth-gated (401/403) on
 * production-equivalent stages. Findings:
 *   - P0 if a 2xx is returned without a valid E2E_CLEANUP_SECRET (real auth bypass)
 *   - P1 if the response is anything other than 404/401/403 (e.g. 200 after validation,
 *     500 internal error) - the endpoint is reachable in an unintended way
 *   - No finding for 401/403/404 on production-like stages (the intended posture)
 */
export async function e2eExposureProbe(
  targetUrl: string,
  stage: string
): Promise<{ probeName: string; findings: AttackSimulationFinding[]; error?: string }> {
  try {
    const target = assertTargetUrlIsSafe(targetUrl);
    const findings: AttackSimulationFinding[] = [];

    // E2E endpoints are expected to be enabled on dev. Only a finding on production-like stages.
    const expectClosed = stage === 'production' || stage.startsWith('pr');

    for (const path of E2E_PATHS) {
      const url = `${target.origin}${path}`;
      const response = await probeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (response.wafBlocked) continue;

      // Hitting the endpoint without auth should never succeed.
      if (response.status >= 200 && response.status < 300) {
        findings.push({
          fingerprint: buildFingerprint(
            'authz',
            `POST ${path}`,
            'E2E test endpoint accepts requests without authentication'
          ),
          category: 'authz',
          severity: 'P0',
          endpoint: `POST ${path}`,
          title: 'E2E test endpoint accepts requests without authentication',
          details: `Endpoint returned ${response.status} for an unauthenticated request.`,
          reproduction: `curl -X POST ${url} -H 'Content-Type: application/json' -d '{}'`,
        });
      } else if (expectClosed && !SAFE_GATED_STATUSES.has(response.status)) {
        findings.push({
          fingerprint: buildFingerprint('config', `POST ${path}`, 'E2E test endpoint reachable on non-dev stage'),
          category: 'config',
          severity: 'P1',
          endpoint: `POST ${path}`,
          title: 'E2E test endpoint reachable on non-dev stage',
          details: `Endpoint returned ${response.status} on stage ${stage}; expected 404 (absent) or 401/403 (auth-gated).`,
          reproduction: `curl -X POST ${url}`,
        });
      }
    }

    return { probeName: PROBE_NAME, findings };
  } catch (err) {
    return {
      probeName: PROBE_NAME,
      findings: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
