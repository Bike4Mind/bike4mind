import { isIP } from 'node:net';
import { AuthStrategy, escapeSlackText, toAbsoluteUrl, type INetworkMeta } from '@bike4mind/common';
import {
  adminSettingsRepository,
  authEventRepository,
  cacheRepository,
  shadowDetectionRepository,
  usageEventRepository,
  userRepository,
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
import { sharedLinkKinds } from '@bike4mind/server-utils/security/accountLinkSignals';
import { hostingNetworkOf } from './datacenterAsns';

/**
 * Signup network burst alerting: when several self-serve accounts sign up from one IP or one network
 * (ASN) within a short window, post to the security alerts channel. Alert-only, and the earliest point
 * a scripted signup wave is visible (the payment-time signals in billing/paymentRisk.ts need money to
 * move first). Runs inline at signup rather than on a cron, so the alert lands with the account that
 * tripped it; a Cache claim keyed by IP or ASN keeps it to one alert per network per window across
 * Lambdas. The refusal caps for the same networks live in signupNetworkLimits.ts.
 *
 * A signup that trips any burst is also recorded as one shadow detection (what the policy would have
 * done; it never acts) for admin grading, behind the shadowDetectionRecordingEnabled kill switch.
 *
 * Households and carrier NAT put a few unrelated people behind one residential IP, so an IP burst
 * below signupNetworkAlertMinUncorroboratedPerIp fires only with a corroborating signal: a hosting
 * or anonymous-IP network, or an earlier signup on the IP that shares this one's JA4, mailbox or
 * (non-consumer) mail domain, or has already spent credits.
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
 * The shadow-detection policy for a burst (shadowDetection.ts in @bike4mind/common). Every burst
 * would contain the latest account. v1 fired on the IP count alone; v2 needs a corroborating signal
 * below the uncorroborated IP threshold. Bump when the burst-to-action mapping changes, so precision
 * is measured per policy.
 */
export const SIGNUP_NETWORK_BURST_POLICY_VERSION = 2;

/** Earlier signups on the IP read for corroboration; the count is small by the time this runs. */
const CORROBORATION_SIBLING_LIMIT = 20;

/** What ties an IP burst's signups to one operator beyond sharing the address. */
export const SIGNUP_NETWORK_CORROBORATIONS = [
  /** The signup came from a hosting/datacenter ASN or carried the WAF anonymous-IP label. */
  'anonymousNetwork',
  'sharedJa4',
  /** Same delivering inbox (plus tags and Gmail dots folded). */
  'sharedMailbox',
  /** Same non-consumer mail domain. */
  'sharedMailDomain',
  /** An earlier signup on the IP already spent credits in the window. */
  'siblingSpent',
] as const;
export type SignupNetworkCorroboration = (typeof SIGNUP_NETWORK_CORROBORATIONS)[number];

const CORROBORATION_LABELS: Record<SignupNetworkCorroboration, string> = {
  anonymousNetwork: 'Hosting or anonymous-IP network',
  sharedJa4: 'Shares a JA4 with an earlier signup on this IP',
  sharedMailbox: 'Shares a mailbox with an earlier signup on this IP',
  sharedMailDomain: 'Shares a mail domain with an earlier signup on this IP',
  siblingSpent: 'An earlier signup on this IP already spent credits',
};

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
  /** An IP burst with no corroborating signal fires only from this many signups. */
  minUncorroboratedPerIp: number;
  maxPerHostingAsn: number;
  maxPerAsn: number;
};

/** Counts are null when not checked; Infinity when the scan was truncated (far over any threshold). */
export type SignupNetworkCounts = { ipSignups: number | null; asnSignups: number | null };

export type SignupNetworkBurst =
  | { scope: 'ip'; signups: number; max: number; corroboratedBy: SignupNetworkCorroboration[] }
  | { scope: 'asn'; signups: number; max: number; hosting: boolean };

export function readSignupNetworkAlertThresholds(settings: Record<string, string>): SignupNetworkAlertThresholds {
  return {
    enabled: getSettingsValue('signupNetworkAlertsEnabled', settings, true),
    windowMinutes: getSettingsValue('signupNetworkAlertWindowMinutes', settings, 180),
    maxPerIp: getSettingsValue('signupNetworkAlertMaxPerIp', settings, 1),
    minUncorroboratedPerIp: getSettingsValue('signupNetworkAlertMinUncorroboratedPerIp', settings, 3),
    maxPerHostingAsn: getSettingsValue('signupNetworkAlertMaxPerHostingAsn', settings, 2),
    maxPerAsn: getSettingsValue('signupNetworkAlertMaxPerAsn', settings, 0),
  };
}

/** The ASN threshold for a signup: the stricter of the any-network and (when hosted) hosting ones; 0 is off. */
export function asnThresholdFor(thresholds: SignupNetworkAlertThresholds, hosting: boolean | null): number {
  const applicable = [thresholds.maxPerAsn, hosting === true ? thresholds.maxPerHostingAsn : 0].filter(max => max > 0);
  return applicable.length > 0 ? Math.min(...applicable) : 0;
}

/** Whether the IP count is over maxPerIp; corroboration is only worth reading then. */
export function ipOverThreshold(counts: SignupNetworkCounts, thresholds: SignupNetworkAlertThresholds): boolean {
  return thresholds.maxPerIp > 0 && counts.ipSignups !== null && counts.ipSignups > thresholds.maxPerIp;
}

/** Whether an IP count over maxPerIp fires without corroboration. */
export function ipFiresUncorroborated(signups: number, thresholds: SignupNetworkAlertThresholds): boolean {
  return signups >= thresholds.minUncorroboratedPerIp;
}

/**
 * The bursts one signup's network counts trip. A 0 threshold or an unchecked (null) count never
 * trips. An IP count over maxPerIp trips when it reaches minUncorroboratedPerIp or when
 * `corroboration` names at least one signal; a hosting network corroborates by itself.
 */
export function evaluateSignupNetworkBursts(input: {
  counts: SignupNetworkCounts;
  hosting: boolean | null;
  thresholds: SignupNetworkAlertThresholds;
  corroboration?: readonly SignupNetworkCorroboration[];
}): SignupNetworkBurst[] {
  const { counts, hosting, thresholds } = input;
  const bursts: SignupNetworkBurst[] = [];
  if (counts.ipSignups !== null && ipOverThreshold(counts, thresholds)) {
    const corroboratedBy = SIGNUP_NETWORK_CORROBORATIONS.filter(
      signal => (signal === 'anonymousNetwork' && hosting === true) || input.corroboration?.includes(signal)
    );
    if (corroboratedBy.length > 0 || ipFiresUncorroborated(counts.ipSignups, thresholds)) {
      bursts.push({ scope: 'ip', signups: counts.ipSignups, max: thresholds.maxPerIp, corroboratedBy });
    }
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
    ...(burst.scope === 'ip' && burst.corroboratedBy.length > 0
      ? [`*Corroborated by:* ${burst.corroboratedBy.map(signal => CORROBORATION_LABELS[signal]).join('; ')}`]
      : []),
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
    signals: bursts.flatMap(burst => [
      {
        key: burst.scope === 'ip' ? 'ipSignups' : 'asnSignups',
        label: burst.scope === 'ip' ? 'Self-serve signups from this IP' : 'Self-serve signups from this network',
        // JSON and Mongo cannot hold Infinity; a truncated count is unknown beyond the scan cap.
        observed: Number.isFinite(burst.signups) ? burst.signups : null,
        threshold: burst.max,
      },
      ...(burst.scope === 'ip'
        ? burst.corroboratedBy.map(signal => ({
            key: signal,
            label: `${CORROBORATION_LABELS[signal]} (1 yes)`,
            observed: 1,
            threshold: null,
          }))
        : []),
    ]),
    windowMinutes,
    group: null,
    payment: null,
    detectedAt,
  };
}

export type SignupCorroborationDeps = {
  findRecentSignupsOnIp: (input: {
    ip: string;
    excludeUserId: string;
    since: Date;
    until: Date;
    limit: number;
  }) => Promise<{ userId: string; ja4: string | null }[]>;
  findEmails: (ids: string[]) => Promise<{ id: string; email: string | null }[]>;
  spendSince: (ids: string[], since: Date) => Promise<Record<string, { totalCredits: number }>>;
};

const liveCorroborationDeps: SignupCorroborationDeps = {
  findRecentSignupsOnIp: input => authEventRepository.findRecentSignupsOnIp(input),
  findEmails: ids => userRepository.findLinkStatesByIds(ids),
  spendSince: (ids, since) => usageEventRepository.spendProfileByUsers(ids, since, 1),
};

/**
 * The signals beyond the shared address that tie this signup to the earlier ones on its IP in the
 * window. The hosting network signal is not read here: evaluateSignupNetworkBursts derives it.
 */
export async function readIpCorroboration(input: {
  network: Pick<INetworkMeta, 'ip' | 'ja4'>;
  userId: string;
  since: Date;
  until: Date;
  deps?: SignupCorroborationDeps;
}): Promise<SignupNetworkCorroboration[]> {
  const { network, userId, since, until, deps = liveCorroborationDeps } = input;
  if (!network.ip) return [];
  const siblings = await deps.findRecentSignupsOnIp({
    ip: network.ip,
    excludeUserId: userId,
    since,
    until,
    limit: CORROBORATION_SIBLING_LIMIT,
  });
  if (siblings.length === 0) return [];
  const siblingIds = [...new Set(siblings.map(sibling => sibling.userId))];
  const [accounts, spend] = await Promise.all([
    deps.findEmails([userId, ...siblingIds]),
    deps.spendSince(siblingIds, since),
  ]);
  const emailOf = (id: string) => accounts.find(account => account.id === id)?.email ?? null;
  // Only the mail traits: every sibling shares the IP by construction, and JA4 is read per signup.
  const mailKinds = siblingIds.flatMap(id =>
    sharedLinkKinds(
      { email: emailOf(userId), signupIp: null, signupJa4: null },
      { email: emailOf(id), signupIp: null, signupJa4: null }
    )
  );
  const found = new Set<SignupNetworkCorroboration>();
  if (network.ja4 && siblings.some(sibling => sibling.ja4 === network.ja4)) found.add('sharedJa4');
  if (mailKinds.includes('mailbox')) found.add('sharedMailbox');
  if (mailKinds.includes('mailDomain')) found.add('sharedMailDomain');
  if (siblingIds.some(id => (spend[id]?.totalCredits ?? 0) > 0)) found.add('siblingSpent');
  return SIGNUP_NETWORK_CORROBORATIONS.filter(signal => found.has(signal));
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
    const now = new Date();
    const { ipSignups, asnSignups } = await countRecentSignups({
      network,
      at: now,
      windows: { ip: checkIp, prefix: false, asn: checkAsn },
      windowMs: { ip: windowMs, asn: windowMs },
      traceFallback: logger,
    });
    // A checked key with a null count means the scan was truncated, i.e. far over any threshold.
    const counts: SignupNetworkCounts = {
      ipSignups: checkIp ? (ipSignups ?? Infinity) : null,
      asnSignups: checkAsn ? (asnSignups ?? Infinity) : null,
    };
    // Read only when it decides the outcome: over the IP threshold, short of the uncorroborated
    // one, on a network that does not corroborate by itself.
    const needsCorroboration =
      counts.ipSignups !== null &&
      ipOverThreshold(counts, thresholds) &&
      !ipFiresUncorroborated(counts.ipSignups, thresholds) &&
      hosting !== true;
    const corroboration = needsCorroboration
      ? await readIpCorroboration({
          network,
          userId,
          since: new Date(now.getTime() - windowMs),
          until: now,
        }).catch((error: unknown) => {
          logger.warn('[signup-network-alerts] Corroboration read failed; treating the burst as uncorroborated', {
            error,
          });
          return [];
        })
      : [];
    const bursts = evaluateSignupNetworkBursts({ counts, hosting, thresholds, corroboration });
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
