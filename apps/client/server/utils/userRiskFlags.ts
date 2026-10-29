import type { AdminUserRiskFlag, UserSignIn } from '@bike4mind/common';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Thresholds for every risk rule; the rule text on each flag is generated from these values. */
export const RISK_RULE_CONFIG = {
  failedSignIns: { windowHours: 24, threshold: 5 },
  newSignIn: { windowDays: 7, minPriorSuccessSignIns: 3 },
  creditSpike: {
    recentDays: 7,
    baselineDays: 30,
    multiplier: 3,
    minBaselineActiveDays: 7,
    minBaselineCredits: 100,
    minRecentCredits: 200,
  },
  moderation: { windowDays: 30, threshold: 1 },
} as const;

export type RiskRuleConfig = typeof RISK_RULE_CONFIG;

export type RiskSignIn = Pick<UserSignIn, 'result' | 'event'> &
  Partial<Pick<UserSignIn, 'ip' | 'browser' | 'operatingSystem'>> & { at: Date | string };
export type RiskDailyCredits = { day: string; credits: number };
export type RiskModerationIncident = {
  createdAt: Date | string;
  labels?: Array<{ name: string }>;
  reviewStatus?: string;
};

export type UserRiskInputs = {
  signIns: readonly RiskSignIn[];
  dailyCredits: readonly RiskDailyCredits[];
  moderationIncidents: readonly RiskModerationIncident[];
};

const ms = (value: Date | string) => new Date(value).getTime();
const iso = (value: number) => new Date(value).toISOString();
const utcDayStart = (value: number) => {
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export const evaluateFailedSignIns = (
  entries: readonly RiskSignIn[],
  now: Date,
  cfg: RiskRuleConfig['failedSignIns'] = RISK_RULE_CONFIG.failedSignIns
): AdminUserRiskFlag | null => {
  const to = now.getTime();
  const from = to - cfg.windowHours * HOUR_MS;
  const hits = entries.filter(e => e.result !== 'success' && ms(e.at) >= from && ms(e.at) <= to);
  if (hits.length < cfg.threshold) return null;
  const counts = new Map<string, number>();
  for (const hit of hits) counts.set(hit.event, (counts.get(hit.event) ?? 0) + 1);
  const latest = Math.max(...hits.map(h => ms(h.at)));
  return {
    id: 'failed_sign_ins',
    severity: hits.length >= cfg.threshold * 2 ? 'high' : 'warn',
    rule: `${cfg.threshold} or more failed or blocked sign-ins in ${cfg.windowHours} hours (counts failed identity checks and blocked sessions; the audit does not record failed passwords)`,
    evidence: [
      { label: 'Failed or blocked sign-ins', value: String(hits.length) },
      ...[...counts].map(([event, count]) => ({ label: event, value: String(count) })),
      { label: 'Most recent', value: iso(latest) },
    ],
    window: { from: iso(from), to: iso(to) },
    timeline: { types: ['signin'], from: iso(from), to: iso(to) },
  };
};

// deviceType is left out: it only exists on sign-ins matched to a login record, so older priors would
// never match a recent one and read as a new device.
const deviceKey = (e: RiskSignIn) => (e.browser && e.operatingSystem ? `${e.browser}|${e.operatingSystem}` : undefined);
const knownIp = (e: RiskSignIn) => (e.ip && e.ip.toLowerCase() !== 'unknown' ? e.ip : undefined);

export const evaluateNewSignIn = (
  entries: readonly RiskSignIn[],
  now: Date,
  cfg: RiskRuleConfig['newSignIn'] = RISK_RULE_CONFIG.newSignIn
): AdminUserRiskFlag | null => {
  const to = now.getTime();
  const from = to - cfg.windowDays * DAY_MS;
  const successes = entries.filter(e => e.result === 'success' && ms(e.at) <= to).sort((a, b) => ms(b.at) - ms(a.at));
  const recent = successes.filter(e => ms(e.at) >= from);
  const prior = successes.filter(e => ms(e.at) < from);
  if (prior.length < cfg.minPriorSuccessSignIns) return null;

  const knownIps = new Set(prior.map(knownIp).filter((v): v is string => v !== undefined));
  const knownDevices = new Set(prior.map(deviceKey).filter((v): v is string => v !== undefined));
  const hit = recent.find(e => {
    const ip = knownIp(e);
    const device = deviceKey(e);
    return (ip !== undefined && !knownIps.has(ip)) || (device !== undefined && !knownDevices.has(device));
  });
  if (!hit) return null;

  const ip = knownIp(hit);
  const device = deviceKey(hit);
  const newIp = ip !== undefined && !knownIps.has(ip);
  return {
    id: 'new_ip_or_device',
    severity: 'info',
    rule: `A successful sign-in in the last ${cfg.windowDays} days from an IP address or device not seen in earlier successful sign-ins (needs ${cfg.minPriorSuccessSignIns} or more earlier sign-ins)`,
    evidence: [
      { label: 'Signed in at', value: iso(ms(hit.at)) },
      ...(ip ? [{ label: newIp ? 'New IP address' : 'IP address', value: ip }] : []),
      ...(device
        ? [{ label: newIp ? 'Device' : 'New device', value: device.split('|').filter(Boolean).join(', ') }]
        : []),
      { label: 'Earlier successful sign-ins', value: String(prior.length) },
    ],
    window: { from: iso(from), to: iso(to) },
    timeline: { types: ['signin'], from: iso(from), to: iso(to) },
  };
};

export const evaluateCreditSpike = (
  daily: readonly RiskDailyCredits[],
  now: Date,
  cfg: RiskRuleConfig['creditSpike'] = RISK_RULE_CONFIG.creditSpike
): AdminUserRiskFlag | null => {
  const today = utcDayStart(now.getTime());
  const recentStart = today - (cfg.recentDays - 1) * DAY_MS;
  const baselineStart = recentStart - cfg.baselineDays * DAY_MS;
  const dayMs = (d: RiskDailyCredits) => Date.parse(`${d.day}T00:00:00.000Z`);

  const recent = daily.filter(d => dayMs(d) >= recentStart && dayMs(d) <= today);
  const baseline = daily.filter(d => dayMs(d) >= baselineStart && dayMs(d) < recentStart);
  const recentTotal = recent.reduce((sum, d) => sum + d.credits, 0);
  const baselineTotal = baseline.reduce((sum, d) => sum + d.credits, 0);
  const activeDays = baseline.filter(d => d.credits > 0).length;
  if (activeDays < cfg.minBaselineActiveDays || baselineTotal < cfg.minBaselineCredits) return null;
  if (recentTotal < cfg.minRecentCredits) return null;

  const baselineAvgPerRecentWindow = (baselineTotal / cfg.baselineDays) * cfg.recentDays;
  if (recentTotal < baselineAvgPerRecentWindow * cfg.multiplier) return null;

  const from = iso(recentStart);
  const to = iso(now.getTime());
  return {
    id: 'credit_spike',
    severity: recentTotal >= baselineAvgPerRecentWindow * cfg.multiplier * 2 ? 'high' : 'warn',
    rule: `Credits spent in the last ${cfg.recentDays} days are at least ${cfg.multiplier}x the average for the ${cfg.baselineDays} days before (needs ${cfg.minBaselineActiveDays} or more active days and ${cfg.minBaselineCredits} credits in that baseline, and ${cfg.minRecentCredits} credits recently)`,
    evidence: [
      { label: `Credits spent, last ${cfg.recentDays} days`, value: String(recentTotal) },
      { label: `Baseline average per ${cfg.recentDays} days`, value: baselineAvgPerRecentWindow.toFixed(1) },
      { label: 'Baseline active days', value: String(activeDays) },
    ],
    window: { from, to },
    timeline: { types: ['usage'], from, to },
  };
};

export const evaluateModeration = (
  incidents: readonly RiskModerationIncident[],
  now: Date,
  cfg: RiskRuleConfig['moderation'] = RISK_RULE_CONFIG.moderation
): AdminUserRiskFlag | null => {
  const to = now.getTime();
  const from = to - cfg.windowDays * DAY_MS;
  const hits = incidents.filter(
    i => i.reviewStatus !== 'false_positive' && ms(i.createdAt) >= from && ms(i.createdAt) <= to
  );
  if (hits.length < cfg.threshold) return null;
  const labels = [...new Set(hits.flatMap(i => (i.labels ?? []).map(l => l.name)))];
  return {
    id: 'prior_moderation',
    severity: 'warn',
    rule: `${cfg.threshold} or more image moderation incidents in the last ${cfg.windowDays} days`,
    evidence: [
      { label: 'Moderation incidents', value: String(hits.length) },
      { label: 'Most recent', value: iso(Math.max(...hits.map(i => ms(i.createdAt)))) },
      ...(labels.length > 0 ? [{ label: 'Labels', value: labels.join(', ') }] : []),
    ],
    window: { from: iso(from), to: iso(to) },
  };
};

export const evaluateUserRisk = (
  inputs: UserRiskInputs,
  now: Date,
  cfg: RiskRuleConfig = RISK_RULE_CONFIG
): AdminUserRiskFlag[] =>
  [
    evaluateFailedSignIns(inputs.signIns, now, cfg.failedSignIns),
    evaluateNewSignIn(inputs.signIns, now, cfg.newSignIn),
    evaluateCreditSpike(inputs.dailyCredits, now, cfg.creditSpike),
    evaluateModeration(inputs.moderationIncidents, now, cfg.moderation),
  ].filter((flag): flag is AdminUserRiskFlag => flag !== null);
