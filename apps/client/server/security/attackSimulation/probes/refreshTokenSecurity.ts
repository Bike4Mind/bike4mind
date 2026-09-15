import type { AttackSimulationFinding } from '../types';
import { buildFingerprint } from '../fingerprint';
import { assertTargetUrlIsSafe, probeFetch } from './probeUtils';

const PROBE_NAME = 'refreshTokenSecurity';

/**
 * Probe 4 - refresh token reuse / rotation.
 * Sends a POST /api/auth/refresh with a clearly invalid token. Expects 401. If the endpoint
 * accepts the token (200/2xx) or returns a different error code that suggests permissive
 * behavior, raise a finding. Real reuse-detection requires a captured token; this probe
 * only catches the basic "any input is accepted" failure mode.
 */
export async function refreshTokenSecurityProbe(
  targetUrl: string
): Promise<{ probeName: string; findings: AttackSimulationFinding[]; error?: string }> {
  try {
    const target = assertTargetUrlIsSafe(targetUrl);
    const endpoint = `${target.origin}/api/auth/refresh`;
    const findings: AttackSimulationFinding[] = [];

    const response = await probeFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'invalid-token-do-not-use' }),
    });

    if (response.wafBlocked) {
      // Same signal pattern as otcSendFlood: if WAF intercepts the
      // probe we cannot verify behavior, so flag it as a low-severity config issue rather
      // than producing zero output (which would silently look like a passing test).
      findings.push({
        fingerprint: buildFingerprint(
          'config',
          'POST /api/auth/refresh',
          'WAF blocked refresh-token probe — switch to COUNT mode for accurate results'
        ),
        category: 'config',
        severity: 'P3',
        endpoint: 'POST /api/auth/refresh',
        title: 'WAF blocked refresh-token probe — switch to COUNT mode for accurate results',
        details:
          'Refresh endpoint probe was blocked by WAF before reaching the application; behavior cannot be verified.',
        reproduction: `curl -X POST ${endpoint} -H 'Content-Type: application/json' -d '{"refreshToken":"invalid"}'`,
      });
      return { probeName: PROBE_NAME, findings };
    }

    if (response.status >= 200 && response.status < 300) {
      findings.push({
        fingerprint: buildFingerprint('auth', 'POST /api/auth/refresh', 'Refresh endpoint accepts invalid tokens'),
        category: 'auth',
        severity: 'P0',
        endpoint: 'POST /api/auth/refresh',
        title: 'Refresh endpoint accepts invalid tokens',
        details: `Refresh endpoint returned ${response.status} for an obviously invalid token.`,
        reproduction: `curl -X POST ${endpoint} -H 'Content-Type: application/json' -d '{"refreshToken":"invalid"}'`,
      });
    } else if (
      response.status !== 401 &&
      response.status !== 403 &&
      response.status !== 400 &&
      response.status !== 404
    ) {
      findings.push({
        fingerprint: buildFingerprint(
          'auth',
          'POST /api/auth/refresh',
          'Refresh endpoint returns unexpected status for invalid token'
        ),
        category: 'auth',
        severity: 'P2',
        endpoint: 'POST /api/auth/refresh',
        title: 'Refresh endpoint returns unexpected status for invalid token',
        details: `Expected 401/403/400/404 for invalid token, got ${response.status}.`,
        reproduction: `curl -X POST ${endpoint} -H 'Content-Type: application/json' -d '{"refreshToken":"invalid"}'`,
      });
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
