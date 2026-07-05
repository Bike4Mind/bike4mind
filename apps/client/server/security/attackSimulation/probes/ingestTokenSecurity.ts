import type { AttackSimulationFinding } from '../types';
import { buildFingerprint } from '../fingerprint';
import { assertTargetUrlIsSafe, probeFetch } from './probeUtils';

const PROBE_NAME = 'ingestTokenSecurity';

const INGEST_PATHS = [
  '/api/admin/security-dashboard/web-owasp-ingest',
  '/api/admin/security-dashboard/code-semgrep-ingest',
  '/api/admin/security-dashboard/packages-ingest',
  '/api/admin/security-dashboard/secrets-ingest',
  '/api/admin/security-dashboard/cloud-prowler-ingest',
  '/api/admin/security-dashboard/attack-simulation-ingest',
];

/**
 * Probe 7 - ingest endpoint token security.
 * For each ingest endpoint:
 *  - No token -> expect 403
 *  - Wrong token -> expect 403
 *  - 'not-configured' literal -> expect 403 (or 500 if the ingest token isn't set yet)
 *
 * A 404 from any of these endpoints is *not* an authz bypass - it's a coverage-loss signal
 * (endpoint renamed/removed or the probe path list went stale). Treated as P3 `config`
 * rather than P0 `authz` so the GitHub auto-issuer doesn't file false positives.
 */
/**
 * Returns true when an ingest response indicates the endpoint accepted (rather than
 * rejected) an unauthenticated/wrongly-authenticated request. Only 2xx counts: the ingest
 * handler should reject with 403 (bad token), 500 (token not configured), or 404 (endpoint
 * gone). Any other status is logged but not flagged here - it would generate noise without
 * being a definitive bypass signal.
 */
function unauthorizedAccept(status: number): boolean {
  return status >= 200 && status < 300;
}

export async function ingestTokenSecurityProbe(
  targetUrl: string
): Promise<{ probeName: string; findings: AttackSimulationFinding[]; error?: string }> {
  try {
    const target = assertTargetUrlIsSafe(targetUrl);
    const findings: AttackSimulationFinding[] = [];

    for (const path of INGEST_PATHS) {
      const url = `${target.origin}${path}`;

      // No token
      const noTokenResponse = await probeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (noTokenResponse.wafBlocked) continue;

      if (noTokenResponse.status === 404) {
        findings.push({
          fingerprint: buildFingerprint('config', `POST ${path}`, 'Expected ingest endpoint missing'),
          category: 'config',
          severity: 'P3',
          endpoint: `POST ${path}`,
          title: 'Expected ingest endpoint missing',
          details: `Probe expected this ingest endpoint to exist (and reject with 403/500); got 404. The probe path list is out of sync with the codebase — coverage gap.`,
          reproduction: `curl -X POST ${url}`,
        });
        continue;
      }

      if (unauthorizedAccept(noTokenResponse.status)) {
        findings.push({
          fingerprint: buildFingerprint(
            'authz',
            `POST ${path}`,
            'Ingest endpoint accepts requests without an ingest token'
          ),
          category: 'authz',
          severity: 'P0',
          endpoint: `POST ${path}`,
          title: 'Ingest endpoint accepts requests without an ingest token',
          details: `Expected 403 (missing token) or 500 (token not configured); got ${noTokenResponse.status}.`,
          reproduction: `curl -X POST ${url} -H 'Content-Type: application/json' -d '{}'`,
        });
        continue;
      }

      if (noTokenResponse.status !== 403 && noTokenResponse.status !== 500) continue;

      // Wrong token
      const wrongTokenResponse = await probeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-security-ingest-token': 'definitely-wrong-token-do-not-use',
        },
        body: JSON.stringify({}),
      });
      if (!wrongTokenResponse.wafBlocked && unauthorizedAccept(wrongTokenResponse.status)) {
        findings.push({
          fingerprint: buildFingerprint(
            'authz',
            `POST ${path}`,
            'Ingest endpoint accepts requests with an invalid ingest token'
          ),
          category: 'authz',
          severity: 'P0',
          endpoint: `POST ${path}`,
          title: 'Ingest endpoint accepts requests with an invalid ingest token',
          details: `Expected 403 for invalid token; got ${wrongTokenResponse.status}.`,
          reproduction: `curl -X POST ${url} -H 'x-security-ingest-token: wrong'`,
        });
        continue;
      }

      // Literal "not-configured" token
      const notConfiguredResponse = await probeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-security-ingest-token': 'not-configured',
        },
        body: JSON.stringify({}),
      });
      if (!notConfiguredResponse.wafBlocked && unauthorizedAccept(notConfiguredResponse.status)) {
        findings.push({
          fingerprint: buildFingerprint(
            'authz',
            `POST ${path}`,
            'Ingest endpoint accepts the "not-configured" placeholder token'
          ),
          category: 'authz',
          severity: 'P0',
          endpoint: `POST ${path}`,
          title: 'Ingest endpoint accepts the "not-configured" placeholder token',
          details: `Expected 403 or 500; got ${notConfiguredResponse.status}.`,
          reproduction: `curl -X POST ${url} -H 'x-security-ingest-token: not-configured'`,
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
