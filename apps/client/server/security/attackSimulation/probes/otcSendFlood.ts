import type { AttackSimulationFinding } from '../types';
import { buildFingerprint } from '../fingerprint';
import { assertTargetUrlIsSafe, probeFetch } from './probeUtils';

const PROBE_NAME = 'otcSendFlood';
const ATTEMPTS = 15;
const ENDPOINT_PATH = '/api/otc/send';

/**
 * Probe 3 - OTC send flood.
 * Sends 15 POSTs to /api/otc/send and expects rate limiting (429) to kick in.
 * Replaces the old passwordResetFlood probe: password auth was removed, so the
 * OTC sign-in-code endpoint is now the email-flood abuse surface.
 *
 * Scope: each request uses a unique email (`sim-attacker-${i}@test.invalid`), so this
 * probe verifies global/IP-based rate limiting, not the per-recipient send cooldown
 * (keyed per email). Detecting a missing per-recipient limiter needs a variant that
 * sends the same email N times.
 *
 * Email TLD is RFC 2606 `.invalid` so the probe cannot deliver real sign-in codes to
 * actual users even if an account ever exists with that local part.
 */
export async function otcSendFloodProbe(
  targetUrl: string
): Promise<{ probeName: string; findings: AttackSimulationFinding[]; error?: string }> {
  try {
    const target = assertTargetUrlIsSafe(targetUrl);
    const endpoint = `${target.origin}${ENDPOINT_PATH}`;
    const findings: AttackSimulationFinding[] = [];

    let throttledCount = 0;
    let wafBlockedCount = 0;
    let notFoundCount = 0;
    let lastStatus = 0;

    for (let i = 0; i < ATTEMPTS; i += 1) {
      const response = await probeFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `sim-attacker-${i}@test.invalid` }),
      });
      lastStatus = response.status;
      if (response.wafBlocked) {
        wafBlockedCount += 1;
        continue;
      }
      if (response.status === 404) notFoundCount += 1;
      if (response.status === 429) throttledCount += 1;
    }

    const appReachedCount = ATTEMPTS - wafBlockedCount;

    // Always surface a config finding when WAF intercepted any probe traffic.
    if (wafBlockedCount > 0) {
      findings.push({
        fingerprint: buildFingerprint(
          'config',
          `POST ${ENDPOINT_PATH}`,
          'WAF blocked OTC send probe — switch to COUNT mode for accurate results'
        ),
        category: 'config',
        severity: 'P3',
        endpoint: `POST ${ENDPOINT_PATH}`,
        title: 'WAF blocked OTC send probe — switch to COUNT mode for accurate results',
        details: `${wafBlockedCount}/${ATTEMPTS} OTC send attempts were blocked by WAF.`,
        reproduction: `POST ${endpoint} x ${ATTEMPTS}`,
      });
    }

    // If every reaching request returned 404, the endpoint doesn't exist - a coverage gap,
    // not a missing rate limit (the endpoint may be absent in this deployment).
    if (appReachedCount > 0 && notFoundCount === appReachedCount) {
      findings.push({
        fingerprint: buildFingerprint(
          'config',
          `POST ${ENDPOINT_PATH}`,
          'OTC send probe target not present in this deployment'
        ),
        category: 'config',
        severity: 'P3',
        endpoint: `POST ${ENDPOINT_PATH}`,
        title: 'OTC send probe target not present in this deployment',
        details: `Probe expected ${ENDPOINT_PATH} to exist; got 404 for ${notFoundCount}/${appReachedCount} requests reaching the app. The probe path list is out of sync with this codebase — coverage gap, not a security finding.`,
        reproduction: `curl -X POST ${endpoint} -H 'Content-Type: application/json' -d '{"email":"x@x.com"}'`,
      });
      return { probeName: PROBE_NAME, findings };
    }

    // Rate-limit finding fires whenever any requests reached the app and none were throttled.
    // Co-exists with the WAF finding so a partial WAF intercept doesn't mask a real gap.
    if (appReachedCount > 0 && throttledCount === 0) {
      findings.push({
        fingerprint: buildFingerprint('auth', `POST ${ENDPOINT_PATH}`, 'Rate limit missing on OTC send endpoint'),
        category: 'auth',
        severity: 'P1',
        endpoint: `POST ${ENDPOINT_PATH}`,
        title: 'Rate limit missing on OTC send endpoint',
        details: `${appReachedCount}/${ATTEMPTS} OTC send POSTs reached the app and none returned 429. Last status: ${lastStatus}.`,
        reproduction: `for i in $(seq 1 ${ATTEMPTS}); do curl -X POST ${endpoint} -H 'Content-Type: application/json' -d '{"email":"x@x.com"}'; done`,
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
