/**
 * Human labels, units and meanings for the business metrics the hourly anomaly cron compares.
 * The Slack formatter and docs/security/business-metric-alerts.md both read from here, so a
 * metric added to collect.ts gets its label in one place. Metric names are `family` or
 * `family:cut` (spendUsd:openai, requests:user, revenueMinor:usd); unknown families fall back
 * to a count with the raw name as label.
 */

export type MetricUnit = 'count' | 'usd' | 'credits' | 'minor';
export type MetricDirection = 'increase' | 'decrease';
/**
 * How an on-call reader should treat the change. abuse: the direction a signup farm, a shared
 * key or unmetered spend would push it. dip: a business or delivery problem, not fraud.
 * growth: good news that still deserves a look.
 */
export type MetricSignal = 'abuse' | 'dip' | 'growth';

export interface MetricFamily {
  label: string;
  unit: MetricUnit;
  meaning: Record<MetricDirection, string>;
  signal: Record<MetricDirection, MetricSignal>;
}

const SOURCE_CUTS: Record<string, string> = {
  user: 'third-party keys',
  firstParty: 'CLI and desktop',
  unclassified: 'unstamped source',
};

export const METRIC_FAMILIES: Record<string, MetricFamily> = {
  verifiedSignups: {
    label: 'Verified signups',
    unit: 'count',
    meaning: {
      increase:
        'More accounts verified their email than in the same hours yesterday. On a weekday with no campaign running, a sharp rise is the signup-farm pattern.',
      decrease:
        'Fewer accounts verified their email than yesterday. Usually traffic or verification-email delivery; check bounces and the email provider if it keeps falling.',
    },
    signal: { increase: 'abuse', decrease: 'dip' },
  },
  activeUsers: {
    label: 'Active users',
    unit: 'count',
    meaning: {
      increase:
        'More distinct external users were active than yesterday. Check it is real traffic and not one script spread across many accounts.',
      decrease:
        'Fewer distinct external users were active than yesterday. A dip across the whole day points at an outage or a sign-in problem; a one-hour dip is usually noise.',
    },
    signal: { increase: 'abuse', decrease: 'dip' },
  },
  payingSubscribers: {
    label: 'Paying subscribers',
    unit: 'count',
    meaning: {
      increase:
        'More active paid subscriptions than yesterday. Confirm the new subscriptions granted plan access and look normal in Stripe.',
      decrease: 'Fewer active paid subscriptions than yesterday. Check Stripe for cancellations and failed renewals.',
    },
    signal: { increase: 'growth', decrease: 'dip' },
  },
  spendUsd: {
    label: 'Estimated provider spend',
    unit: 'usd',
    meaning: {
      increase:
        'Estimated model spend is up. If credits charged did not rise with it, usage is going unmetered; check young-account spend and the top accounts below.',
      decrease:
        'Estimated model spend is down. Fine if usage fell too; otherwise a provider or model may be failing and the ledger is missing calls.',
    },
    signal: { increase: 'abuse', decrease: 'dip' },
  },
  credits: {
    label: 'Credits charged',
    unit: 'credits',
    meaning: {
      increase:
        'More credits were charged than yesterday. Check whether young accounts are burning free credits and which models carry the increase.',
      decrease:
        'Fewer credits were charged than yesterday. Fine if usage fell too; otherwise check that metering still charges every completion.',
    },
    signal: { increase: 'abuse', decrease: 'dip' },
  },
  requests: {
    label: 'API requests',
    unit: 'count',
    meaning: {
      increase:
        'API-key request volume is up. One key driving it is a runaway script or a shared key; many new keys is the farm pattern.',
      decrease:
        'API-key request volume is down. Check for a failing integration or a rate-limit rule catching legitimate keys.',
    },
    signal: { increase: 'abuse', decrease: 'dip' },
  },
  completions: {
    label: 'API completions',
    unit: 'count',
    meaning: {
      increase:
        'More completions were billed through API keys. One key driving it is a runaway script or a shared key; many new keys is the farm pattern.',
      decrease: 'Fewer completions were billed through API keys. Check for a failing integration or a provider outage.',
    },
    signal: { increase: 'abuse', decrease: 'dip' },
  },
  revenueMinor: {
    label: 'Stripe receipts',
    unit: 'minor',
    meaning: {
      increase:
        'Gross Stripe receipts are up. Card testing shows as many small charges from young accounts; check Radar before celebrating.',
      decrease:
        'Gross Stripe receipts are down. Compare with subscriptions and credit-pack purchases before reading it as churn.',
    },
    signal: { increase: 'abuse', decrease: 'dip' },
  },
};

export interface MetricDescription {
  name: string;
  family: string;
  cut?: string;
  label: string;
  unit: MetricUnit;
  /** ISO 4217 code, upper case, for revenueMinor cuts. */
  currency?: string;
}

const FALLBACK_FAMILY: MetricFamily = {
  label: '',
  unit: 'count',
  meaning: {
    increase: 'This metric rose past its threshold against the same period yesterday.',
    decrease: 'This metric fell past its threshold against the same period yesterday.',
  },
  signal: { increase: 'growth', decrease: 'dip' },
};

const familyFor = (name: string): MetricFamily => METRIC_FAMILIES[name.split(':')[0]] ?? FALLBACK_FAMILY;

export function describeMetric(name: string): MetricDescription {
  const [family, cut] = name.split(':');
  const known = METRIC_FAMILIES[family];
  if (!known) return { name, family, cut, label: name, unit: 'count' };
  if (cut === undefined) return { name, family, label: known.label, unit: known.unit };
  if (family === 'revenueMinor') {
    const currency = cut.toUpperCase();
    return { name, family, cut, label: `${known.label} (${currency})`, unit: 'minor', currency };
  }
  if (family === 'spendUsd') return { name, family, cut, label: `Estimated ${cut} spend`, unit: 'usd' };
  return { name, family, cut, label: `${known.label} (${SOURCE_CUTS[cut] ?? cut})`, unit: known.unit };
}

export const metricMeaning = (name: string, direction: MetricDirection): string => familyFor(name).meaning[direction];

export const metricSignal = (name: string, direction: MetricDirection): MetricSignal =>
  familyFor(name).signal[direction];

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Counts and credits print whole; money prints two decimals with its currency code first. */
export function formatMetricValue(value: number, metric: MetricDescription, withUnit = true): string {
  switch (metric.unit) {
    case 'usd':
      return `${withUnit ? 'USD ' : ''}${money.format(value)}`;
    case 'minor':
      return `${withUnit ? `${metric.currency ?? ''} `.trimStart() : ''}${money.format(value / 100)}`;
    case 'credits':
      return `${integer.format(value)}${withUnit ? ' credits' : ''}`;
    default:
      return integer.format(value);
  }
}

/** Signed delta for a contributor line: "+2,958", "-1", "+USD 12.30". */
export function formatMetricDelta(value: number, metric: MetricDescription): string {
  const sign = value < 0 ? '-' : '+';
  return `${sign}${formatMetricValue(Math.abs(value), metric)}`;
}

const MODEL_VENDORS: Record<string, string> = {
  claude: 'Claude',
  gpt: 'GPT',
  gemini: 'Gemini',
  grok: 'Grok',
  llama: 'Llama',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
};

/**
 * Display name for a model id without loading the adapter catalogs: strips a Bedrock region
 * prefix, then "claude-opus-5-5" reads as "Claude Opus 5.5" and "gpt-5-4-mini" as "GPT-5.4 Mini".
 * A trailing date stamp is dropped; anything unrecognised is returned with dashes as spaces.
 */
export function modelDisplayName(modelId: string): string {
  const id = modelId.replace(/^(?:[a-z]{2}|global)\.[a-z]+\./, '');
  const parts = id.split('-').filter(part => part !== '' && !/^\d{8}$/.test(part));
  if (parts.length === 0) return modelId;
  const vendor = MODEL_VENDORS[parts[0]];
  if (!vendor) return parts.map(capitalise).join(' ');
  const words: string[] = [];
  const version: string[] = [];
  const suffix: string[] = [];
  for (const part of parts.slice(1)) {
    if (/^\d{1,3}[a-z]?$|^\d+\.\d+$/.test(part) && suffix.length === 0) version.push(part);
    else if (version.length === 0) words.push(capitalise(part));
    else suffix.push(capitalise(part));
  }
  const release = version.join('.');
  const head = vendor === 'GPT' && words.length === 0 && release ? `GPT-${release}` : [vendor, ...words, release];
  return [head, ...suffix].flat().filter(Boolean).join(' ');
}

const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
