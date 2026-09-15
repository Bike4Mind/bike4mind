import type { AttackSimulationFinding } from '../types';
import { buildFingerprint } from '../fingerprint';
import { assertTargetUrlIsSafe, probeFetch } from './probeUtils';

const PROBE_NAME = 'adminAuthz';

// Heuristic for detecting stack-trace-shaped content in a response body. Looks for the
// usual suspects: `at Object.<anonymous>`, `node_modules`, file paths with line numbers,
// or Error class markers. Truncated to first 4KB to keep the regex bounded.
const STACK_MARKERS = [
  /\bat [A-Z][a-zA-Z]*\.[a-zA-Z<>]+ \(/,
  /node_modules[/\\]/i,
  /\.(?:ts|js|tsx|jsx):\d+:\d+/,
  /\b(Error|TypeError|ReferenceError|SyntaxError):\s+\w+/,
];
function looksLikeStackTrace(body: string | undefined): boolean {
  if (!body) return false;
  const sample = body.slice(0, 4096);
  return STACK_MARKERS.some(re => re.test(sample));
}

// Real admin endpoints in this codebase. All require `req.user.isAdmin` and must return
// 401/403 for unauthenticated requests. Any 2xx (or sensitive 5xx leakage) is a P0.
const ADMIN_PATHS = [
  '/api/admin/security-dashboard/overview',
  '/api/admin/team-members',
  '/api/admin/agent-ops-settings',
  '/api/admin/system-health',
  '/api/admin/rate-limits',
];

/**
 * Probe 5 - admin authorization.
 * Hits admin endpoints with no auth and expects 401/403. Any 200 (or sensitive 5xx leakage)
 * is treated as P0. A 404 is also a finding because every endpoint in the list above is
 * known to exist - a 404 means the endpoint moved without updating this probe and we have
 * silent coverage loss.
 */
export async function adminAuthzProbe(
  targetUrl: string
): Promise<{ probeName: string; findings: AttackSimulationFinding[]; error?: string }> {
  try {
    const target = assertTargetUrlIsSafe(targetUrl);
    const findings: AttackSimulationFinding[] = [];

    for (const path of ADMIN_PATHS) {
      const url = `${target.origin}${path}`;
      const response = await probeFetch(url, { method: 'GET' });
      if (response.wafBlocked) continue;

      if (response.status >= 200 && response.status < 300) {
        findings.push({
          fingerprint: buildFingerprint('authz', `GET ${path}`, 'Admin endpoint accessible without authentication'),
          category: 'authz',
          severity: 'P0',
          endpoint: `GET ${path}`,
          title: 'Admin endpoint accessible without authentication',
          details: `Endpoint returned ${response.status} for an unauthenticated request.`,
          reproduction: `curl ${url}`,
        });
      } else if (response.status >= 500 && looksLikeStackTrace(response.bodyText)) {
        // 5xx with stack-trace-shaped body on an unauthenticated admin endpoint =
        // information leakage. Treat as P0 - same severity as a real authz bypass because
        // it can disclose internal paths, package versions, and route handlers.
        findings.push({
          fingerprint: buildFingerprint(
            'authz',
            `GET ${path}`,
            'Admin endpoint leaks stack trace on unauthenticated 5xx'
          ),
          category: 'authz',
          severity: 'P0',
          endpoint: `GET ${path}`,
          title: 'Admin endpoint leaks stack trace on unauthenticated 5xx',
          details: `Endpoint returned ${response.status} with a body containing stack-trace markers for an unauthenticated request.`,
          reproduction: `curl -i ${url}`,
        });
      } else if (response.status === 404) {
        findings.push({
          fingerprint: buildFingerprint('config', `GET ${path}`, 'Expected admin endpoint missing'),
          category: 'config',
          severity: 'P3',
          endpoint: `GET ${path}`,
          title: 'Expected admin endpoint missing',
          details: `Probe expected this admin endpoint to exist (and return 401/403); got 404. The probe path list is out of sync with the codebase — coverage gap.`,
          reproduction: `curl ${url}`,
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
