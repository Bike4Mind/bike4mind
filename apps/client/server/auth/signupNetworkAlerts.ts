import { isIP } from 'node:net';
import { AuthStrategy, escapeSlackText, toAbsoluteUrl, type INetworkMeta } from '@bike4mind/common';
import {
  adminSettingsRepository,
  cacheRepository,
  shadowDetectionRepository,
  type RecordShadowDetectionInput,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  countRecentSignups,
  hashSignupNetwork,
  MAX_COUNTED_ROWS,
} from '@bike4mind/server-utils/auth/signupNetworkSignals';
import { postMessageToSlackWithOutcome } from '@bike4mind/server-utils/integrations/slack/slack';
import { hostingNetworkOf } from './datacenterAsns';

/**
 * Signup network burst alerting: when several self-serve accounts sign up from one IP or one network
 * (ASN) within a short window, post to the security alerts channel. Alert-only, and the earliest point
 * a scripted signup wave is visible (the payment-time signals in billing/paymentRisk.ts need money to
 * move first). Runs inline at signup rather than on a cron, so the alert lands with the account that
 * tripped it; a Cache claim keyed by IP or ASN keeps it to one alert per network per window across
 * Lambdas. The refusal caps for the same networks live in signupNetworkLimits.ts.
 *
 * A signup that trips any burst is also recorded as one shadow detection (what policy v1 would have
 * done; it never acts) for admin grading, behind the shadowDetectionRecordingEnabled kill switch.
 */

const MINUTE_MS = 60_000;

// The admin user profile route, as adminOwnerSlackRef (slack/subscriptionLifecycle.ts) links it. Not
// imported from there: that module loads the Subscription model, too heavy for every signup.
function adminUserRef(userId: string): string {
  const id = `\`${escapeSlackText(userId)}\``;
  const appUrl = process.env.APP_URL?.trim();
  if (!appUrl) return id;
  const link = toAbsoluteUrl(appUrl, `/admin/users/${encodeURIComponent(userId)}`);
  return `${id} - <${escapeSlackText(link)}|Open in admin>`;
}
const DEDUPE_KEY_PREFIX = 'signup-network-alert';
// Separate from the alert's claim, so a Slack failure (which releases that claim) never re-records.
const SHADOW_DEDUPE_KEY_PREFIX = 'shadow-detection:signup-network';

/**
 * The shadow-detection policy for a burst (shadowDetection.ts in @bike4mind/common). v1: every burst
 * would contain the latest account. Bump when the burst-to-action mapping changes, so precision is
 * measured per policy.
 */
export const SIGNUP_NETWORK_BURST_POLICY_VERSION = 1;

// Enterprise SSO (Okta, SAML) onboards whole teams from one office network by design.
const SELF_SERVE_SIGNUP_METHODS: ReadonlySet<string> = new Set([
  'otc',
  AuthStrategy.Google,
  AuthStrategy.Github,
  AuthStrategy.Apple,
]);

export type SignupNetworkAlertThresholds = {
  enabled: boolean;
  windowMinutes: number;
  maxPerIp: number;
  maxPerHostingAsn: number;
  maxPerAsn: number;
};

/** Counts are null when not checked; Infinity when the scan was truncated (far over any threshold). */
export type SignupNetworkCounts = { ipSignups: number | null; asnSignups: number | null };

export type SignupNetworkBurst =
  { scope: 'ip'; signups: number; max: number } | { scope: 'asn'; signups: number; max: number; hosting: boolean };

export function readSignupNetworkAlertThresholds(settings: Record<string, string>): SignupNetworkAlertThresholds {
  return {
    enabled: getSettingsValue('signupNetworkAlertsEnabled', settings, true),
    windowMinutes: getSettingsValue('signupNetworkAlertWindowMinutes', settings, 180),
    maxPerIp: getSettingsValue('signupNetworkAlertMaxPerIp', settings, 1),
    maxPerHostingAsn: getSettingsValue('signupNetworkAlertMaxPerHostingAsn', settings, 2),
    maxPerAsn: getSettingsValue('signupNetworkAlertMaxPerAsn', settings, 0),
  };
}

/** The ASN threshold for a signup: the stricter of the any-network and (when hosted) hosting ones; 0 is off. */
export function asnThresholdFor(thresholds: SignupNetworkAlertThresholds, hosting: boolean | null): number {
  const applicable = [thresholds.maxPerAsn, hosting === true ? thresholds.maxPerHostingAsn : 0].filter(max => max > 0);
  return applicable.length > 0 ? Math.min(...applicable) : 0;
}

/** The bursts one signup's network counts trip. A 0 threshold or an unchecked (null) count never trips. */
export function evaluateSignupNetworkBursts(input: {
  counts: SignupNetworkCounts;
  hosting: boolean | null;
  thresholds: SignupNetworkAlertThresholds;
}): SignupNetworkBurst[] {
  const { counts, hosting, thresholds } = input;
  const bursts: SignupNetworkBurst[] = [];
  if (thresholds.maxPerIp > 0 && counts.ipSignups !== null && counts.ipSignups > thresholds.maxPerIp) {
    bursts.push({ scope: 'ip', signups: counts.ipSignups, max: thresholds.maxPerIp });
  }
  const asnMax = asnThresholdFor(thresholds, hosting);
  if (asnMax > 0 && counts.asnSignups !== null && counts.asnSignups > asnMax) {
    bursts.push({ scope: 'asn', signups: counts.asnSignups, max: asnMax, hosting: hosting === true });
  }
  return bursts;
}

export function formatSignupNetworkAlert(input: {
  burst: SignupNetworkBurst;
  network: Pick<INetworkMeta, 'ip' | 'asn' | 'asnOrg' | 'country' | 'isDatacenter' | 'wafAnonIp'>;
  userId: string;
  windowMinutes: number;
}): string {
  const { burst, network, userId, windowMinutes } = input;
  const title =
    burst.scope === 'ip'
      ? 'Signup burst from one IP'
      : burst.hosting
        ? 'Signup burst from one hosting/VPN network'
        : 'Signup burst from one network';
  const signups = `${formatSignupCount(burst.signups)} self-serve accounts`;
  const hosting = hostingNetworkOf(network);
  const asn =
    network.asn === null
      ? 'unknown'
      : `AS${network.asn}${network.asnOrg ? ` (${escapeSlackText(network.asnOrg)})` : ''}`;
  return [
    `:rotating_light: *${title}*`,
    `*Signups:* ${signups} in the last ${windowMinutes} minutes (alerts above ${burst.max})`,
    ...(burst.scope === 'ip' && network.ip ? [`*IP:* \`${escapeSlackText(network.ip)}\``] : []),
    `*Network:* ${asn}, hosting/VPN: ${hosting === null ? 'unknown' : hosting ? 'yes' : 'no'}`,
    ...(network.country ? [`*Country:* ${escapeSlackText(network.country)}`] : []),
    `*Latest account:* ${adminUserRef(userId)}`,
    `No further alert for this ${burst.scope === 'ip' ? 'IP' : 'network'} for ${windowMinutes} minutes.`,
  ].join('\n');
}

function dedupeKey(
  burst: SignupNetworkBurst,
  network: Pick<INetworkMeta, 'ip' | 'asn'>,
  prefix: string = DEDUPE_KEY_PREFIX
): string {
  // The IP is hashed so the Cache row does not hold a raw address past the alert itself.
  return burst.scope === 'ip' ? `${prefix}:ip:${hashSignupNetwork(network.ip).ipHash}` : `${prefix}:asn:${network.asn}`;
}

function formatSignupCount(signups: number): string {
  return Number.isFinite(signups)
    ? signups.toLocaleString('en-US')
    : `more than ${MAX_COUNTED_ROWS.toLocaleString('en-US')}`;
}

async function alertOnce(input: {
  burst: SignupNetworkBurst;
  network: INetworkMeta;
  userId: string;
  windowMinutes: number;
  logger: Logger;
}): Promise<void> {
  const { burst, network, userId, windowMinutes, logger } = input;
  const key = dedupeKey(burst, network);
  try {
    const { claimed } = await cacheRepository.claimDedup(key, { userId }, windowMinutes * MINUTE_MS);
    if (!claimed) return;
    const outcome = await postMessageToSlackWithOutcome(
      formatSignupNetworkAlert({ burst, network, userId, windowMinutes }),
      'SlackSecurityAlertsWebhookUrl',
      { timeoutMs: 3000 }
    );
    // A failed post releases the claim so the next signup retries. 'unconfigured' keeps it: security
    // alerts are switched off, and the Slack module already warned about that.
    if (outcome === 'failed') {
      await cacheRepository.deleteByKey(key);
      logger.error('[signup-network-alerts] Burst alert was not delivered', { scope: burst.scope, asn: network.asn });
    }
  } catch (error) {
    logger.error('[signup-network-alerts] Burst alert failed', { scope: burst.scope, error });
  }
}

/**
 * The shadow detection one signup records: what policy v1 would have done, without doing it. One
 * record per signup however many bursts it tripped (it is one "would contain" decision), with a
 * signal per tripped burst.
 */
export function buildSignupNetworkShadowDetection(input: {
  bursts: [SignupNetworkBurst, ...SignupNetworkBurst[]];
  network: INetworkMeta;
  userId: string;
  windowMinutes: number;
  detectedAt: Date;
}): RecordShadowDetectionInput {
  const { bursts, network, userId, windowMinutes, detectedAt } = input;
  const [first, ...rest] = bursts;
  const counts = [
    `${formatSignupCount(first.signups)} self-serve signups from ${burstSource(first)}`,
    ...rest.map(burst => `${formatSignupCount(burst.signups)} from ${burstSource(burst)}`),
  ];
  return {
    detector: 'signupNetworkBurst',
    policyVersion: SIGNUP_NETWORK_BURST_POLICY_VERSION,
    wouldAction: 'contain',
    summary: `${counts.join(' and ')} in ${windowMinutes} minutes`,
    userIds: [userId],
    network: {
      ip: network.ip,
      asn: network.asn,
      asnOrg: network.asnOrg,
      country: network.country,
      hosting: hostingNetworkOf(network),
    },
    signals: bursts.map(burst => ({
      key: burst.scope === 'ip' ? 'ipSignups' : 'asnSignups',
      label: burst.scope === 'ip' ? 'Self-serve signups from this IP' : 'Self-serve signups from this network',
      // JSON and Mongo cannot hold Infinity; a truncated count is unknown beyond the scan cap.
      observed: Number.isFinite(burst.signups) ? burst.signups : null,
      threshold: burst.max,
    })),
    windowMinutes,
    group: null,
    detectedAt,
  };
}

function burstSource(burst: SignupNetworkBurst): string {
  return burst.scope === 'ip' ? 'one IP' : 'one network';
}

/**
 * Records the signup's bursts as one shadow detection when it wins the shadow claim of at least one
 * tripped network this window. Only writes the record: never touches the account, its credits or
 * keys. A failed write releases the claims it won, so the next signup retries. Never throws.
 */
async function recordShadowDetectionOnce(input: {
  bursts: [SignupNetworkBurst, ...SignupNetworkBurst[]];
  network: INetworkMeta;
  userId: string;
  windowMinutes: number;
  logger: Logger;
}): Promise<void> {
  const { bursts, network, userId, windowMinutes, logger } = input;
  const wonKeys: string[] = [];
  try {
    // allSettled, so a claim won beside one that threw is still known, and released below.
    const claims = await Promise.allSettled(
      bursts.map(async burst => {
        const key = dedupeKey(burst, network, SHADOW_DEDUPE_KEY_PREFIX);
        const { claimed } = await cacheRepository.claimDedup(key, { userId }, windowMinutes * MINUTE_MS);
        if (claimed) wonKeys.push(key);
      })
    );
    const failedClaim = claims.find(claim => claim.status === 'rejected');
    if (failedClaim) throw failedClaim.reason;
    if (wonKeys.length === 0) return;
    await shadowDetectionRepository.record(
      buildSignupNetworkShadowDetection({ bursts, network, userId, windowMinutes, detectedAt: new Date() })
    );
  } catch (error) {
    await Promise.all(wonKeys.map(key => cacheRepository.deleteByKey(key))).catch((releaseError: unknown) =>
      logger.error('[signup-network-alerts] Shadow detection claim was not released', { error: releaseError })
    );
    logger.error('[signup-network-alerts] Shadow detection was not recorded', {
      scopes: bursts.map(burst => burst.scope),
      error,
    });
  }
}

/**
 * Alerts when this signup's IP or network has had more self-serve signups in the window than the
 * admin thresholds allow (settings.ts, signupNetworkAlert*). Call after the signup's AuthEvent is
 * written, so the count includes it. Never throws: a failed alert must not fail an account creation.
 */
export async function alertSignupNetworkBurst(input: {
  network: INetworkMeta;
  userId: string;
  method: string;
}): Promise<void> {
  const { network, userId, method } = input;
  if (!SELF_SERVE_SIGNUP_METHODS.has(method)) return;
  const logger = Logger.globalInstance;
  try {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const thresholds = readSignupNetworkAlertThresholds(settings);
    if (!thresholds.enabled) return;
    const hosting = hostingNetworkOf(network);
    const checkIp = thresholds.maxPerIp > 0 && !!network.ip && isIP(network.ip) > 0;
    const checkAsn = asnThresholdFor(thresholds, hosting) > 0 && network.asn !== null && network.asn > 0;
    if (!checkIp && !checkAsn) return;

    const windowMs = thresholds.windowMinutes * MINUTE_MS;
    const { ipSignups, asnSignups } = await countRecentSignups({
      network,
      at: new Date(),
      windows: { ip: checkIp, prefix: false, asn: checkAsn },
      windowMs: { ip: windowMs, asn: windowMs },
      traceFallback: logger,
    });
    // A checked key with a null count means the scan was truncated, i.e. far over any threshold.
    const bursts = evaluateSignupNetworkBursts({
      counts: {
        ipSignups: checkIp ? (ipSignups ?? Infinity) : null,
        asnSignups: checkAsn ? (asnSignups ?? Infinity) : null,
      },
      hosting,
      thresholds,
    });
    const recordShadow = getSettingsValue('shadowDetectionRecordingEnabled', settings, true);
    const burstInput = { network, userId, windowMinutes: thresholds.windowMinutes, logger };
    const [firstBurst, ...otherBursts] = bursts;
    await Promise.all([
      ...bursts.map(burst => alertOnce({ burst, ...burstInput })),
      ...(recordShadow && firstBurst
        ? [recordShadowDetectionOnce({ bursts: [firstBurst, ...otherBursts], ...burstInput })]
        : []),
    ]);
  } catch (error) {
    logger.error('[signup-network-alerts] Burst check failed', error);
  }
}
