import type { INetworkMeta } from '@bike4mind/common';
import { ja4FingerprintSchema } from '@bike4mind/common';
import { authEventRepository, User } from '@bike4mind/database';
import { isDeployedStage } from '@bike4mind/server-utils/utils/config';
import { getClientIp, getClientNetwork, type ClientIpRequest } from '@bike4mind/server-utils/utils/ip';
import { CLOUDFRONT_VIEWER_JA4_HEADER } from '@bike4mind/server-utils/utils/trustedClientIpHeaders';
import { DATACENTER_ASNS } from './datacenterAsns';
import { requestRiskEvidenceRefresh } from './riskEvidence';
import { alertSignupNetworkBurst } from './signupNetworkAlerts';

// x-amzn-waf- + the InsertHeaders name of the forward-anon-ip-label / forward-bot-signal-label rules
// in infra/waf/bike4mind-api-protection-dev.json.
const WAF_ANON_IP_HEADER = 'x-amzn-waf-x-waf-anon-ip';
const WAF_BOT_SIGNAL_HEADER = 'x-amzn-waf-x-waf-bot-signal';

export type NetworkRequest = ClientIpRequest & {
  headers: Record<string, string | string[] | undefined>;
};

/**
 * The network a request came from. ASN and country come from CloudFront's viewer headers only;
 * when the distribution does not forward them every derived field is null, never a guess.
 */
export function readNetworkMeta(req: NetworkRequest): INetworkMeta {
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'];
  const { asn, country } = getClientNetwork(req);
  const deployed = isDeployedStage();
  const ja4 = deployed ? ja4FingerprintSchema.safeParse(req.headers[CLOUDFRONT_VIEWER_JA4_HEADER]) : null;
  // AWS WAF prefixes every header it inserts with x-amzn-waf-. Null unless the attached ACL carries
  // the label-forward rules (WAF_LABEL_FORWARDING, set in infra/web.ts), so "not checked" is never
  // stored as "clean".
  const wafForwarding = deployed && process.env.WAF_LABEL_FORWARDING === 'true';
  const wafAnonIp = wafForwarding ? req.headers[WAF_ANON_IP_HEADER] === '1' : null;
  const wafBotSignal = wafForwarding ? req.headers[WAF_BOT_SIGNAL_HEADER] === '1' : null;
  return {
    ip: ip === 'unknown' ? null : ip,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) || null,
    asn,
    asnOrg: asn === null ? null : (DATACENTER_ASNS.get(asn) ?? null),
    country,
    isDatacenter: asn === null ? null : DATACENTER_ASNS.has(asn),
    ja4: ja4?.success ? ja4.data : null,
    wafAnonIp,
    wafBotSignal,
  };
}

// console.warn, as recordSignupAcquisition does: a log call that could itself throw would break
// the never-throw contract below.
function warnNotRecorded(what: string, err: unknown): void {
  console.warn(`[auth] ${what} not recorded`, err instanceof Error ? err.message : err);
}

async function requestRiskEvidenceRefreshSafely(userId: string, trigger: 'signup' | 'login'): Promise<void> {
  try {
    await requestRiskEvidenceRefresh(userId, trigger, console);
  } catch (err) {
    warnNotRecorded('risk evidence refresh request', err);
  }
}

/**
 * Stamp the signup's network on the new user (once: a retried handler keeps the first capture), log a
 * signup AuthEvent, and raise a burst alert when its IP or network is busy. Each step fails on its
 * own. Never throws: losing this metadata must not
 * fail an account creation.
 */
export async function recordSignupNetwork(opts: {
  req: NetworkRequest;
  userId: string;
  method: string;
}): Promise<void> {
  const meta = readNetworkMeta(opts.req);
  try {
    await User.updateOne(
      { _id: opts.userId, signupMeta: null },
      { $set: { signupMeta: { ...meta, capturedAt: new Date() } } }
    );
  } catch (err) {
    warnNotRecorded('signup network metadata', err);
  }
  try {
    await authEventRepository.record({ ...meta, userId: opts.userId, type: 'signup', method: opts.method });
  } catch (err) {
    warnNotRecorded('signup event', err);
  }
  // After the AuthEvent write, so the burst count includes this account.
  await alertSignupNetworkBurst({ network: meta, userId: opts.userId, method: opts.method });
  await requestRiskEvidenceRefreshSafely(opts.userId, 'signup');
}

/** Log a login AuthEvent. Never throws: a lost row must not fail the sign-in. */
export async function recordLoginEvent(opts: { req: NetworkRequest; userId: string; method: string }): Promise<void> {
  try {
    await authEventRepository.record({
      ...readNetworkMeta(opts.req),
      userId: opts.userId,
      type: 'login',
      method: opts.method,
    });
  } catch (err) {
    warnNotRecorded('login event', err);
  }
  await requestRiskEvidenceRefreshSafely(opts.userId, 'login');
}
