import type { AttackSimulationFinding } from '../types';
import { buildFingerprint } from '../fingerprint';
import { assertTargetUrlIsSafe, probeFetch } from './probeUtils';

const PROBE_NAME = 'openRedirect';

const REDIRECT_PROBES = [
  '/api/redirect?url=https://evil.example.com',
  '/api/click?to=https://evil.example.com',
  '/r?url=https://evil.example.com',
];

const EXTERNAL_HOST = 'evil.example.com';

/**
 * Probe 6 - open redirect.
 * Probes common click-tracking patterns with an external destination. Any 30x to evil.example.com
 * is an open redirect.
 */
export async function openRedirectProbe(
  targetUrl: string
): Promise<{ probeName: string; findings: AttackSimulationFinding[]; error?: string }> {
  try {
    const target = assertTargetUrlIsSafe(targetUrl);
    const findings: AttackSimulationFinding[] = [];

    for (const path of REDIRECT_PROBES) {
      const url = `${target.origin}${path}`;
      const response = await probeFetch(url, { method: 'GET' });
      if (response.wafBlocked) continue;

      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect) continue;

      const location = response.headers['location'] || '';
      // Hostnames are case-insensitive per RFC 3986; lowercase the Location value before
      // matching so `Location: https://EVIL.EXAMPLE.COM/...` is detected.
      if (location.toLowerCase().includes(EXTERNAL_HOST)) {
        findings.push({
          fingerprint: buildFingerprint(
            'misc',
            `GET ${path.split('?')[0]}`,
            'Open redirect to attacker-controlled host'
          ),
          category: 'misc',
          severity: 'P1',
          endpoint: `GET ${path.split('?')[0]}`,
          title: 'Open redirect to attacker-controlled host',
          details: `Endpoint returned ${response.status} with Location: ${location}`,
          reproduction: `curl -i '${url}'`,
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
