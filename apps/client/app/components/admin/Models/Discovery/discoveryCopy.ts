import type { AdminModelStatus } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import type {
  DiscoveryChangeCounts,
  DiscoveryRun,
  DiscoveryRunListItem,
  PerMTokRates,
  StaleReferenceProblem,
} from './discoveryApi';

/** Plain-language copy for the discovery pages. */

export const RUN_RETENTION_NOTE = 'Runs are kept for 90 days. Decisions they raised stay on each model.';
export const RUN_EXPIRED_TITLE = 'This run has expired. Runs are kept for 90 days.';
export const DISCOVERY_OFF_TITLE = 'Discovery is off';
export const DISCOVERY_OFF_DESCRIPTION = 'Turn it on to check providers for new models every 6 hours.';
export const LISTING_IN_PROGRESS = 'A listing is in progress, try again in a few seconds';
export const REPORT_MODE_BANNER =
  'This run only reported. Nothing was saved. Switch discovery to Writes changes in Settings to apply what it finds.';
export const NOT_SAVED_NOTE = 'Not saved: this run only reported';

/** The cron runs every 6 hours (MODEL_DISCOVERY_SCHEDULE_BY_STAGE in infra/cron.ts). */
const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const plural = (count: number, one: string, many = `${one}s`) => (count === 1 ? one : many);

const capitalize = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

const sameDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const clock = (date: Date) => date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "Today 09:12", "Yesterday 18:20", else the date and time. */
export function formatRunTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  if (sameDay(date, now)) return `Today ${clock(date)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday ${clock(date)}`;
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return `${date.toLocaleDateString(undefined, options)}, ${clock(date)}`;
}

const TRIGGER_LABEL: Record<string, string> = { cron: 'Scheduled', manual: 'Manual', startup: 'Startup' };
export const triggerLabel = (trigger: string): string => TRIGGER_LABEL[trigger] ?? capitalize(trigger);

const MODE_LABEL: Record<string, string> = { report: 'Report only', write: 'Writes changes' };
export const modeLabel = (mode: string | undefined): string => (mode ? (MODE_LABEL[mode] ?? mode) : 'Not recorded');

const POLICY_LABEL: Record<string, string> = {
  priced: 'New models listed when priced',
  manual: 'New models wait for approval',
  all: 'New models listed automatically',
};
export const policyLabel = (policy: string): string => POLICY_LABEL[policy] ?? `New models: ${policy}`;

// Past the discovery job's longest possible run (its Lambda timeout in infra/cron.ts, also the default budget of a
// self-hosted run), so a run still unfinished by then was killed and will never record its finish.
export const UNFINISHED_RUN_LIMIT_MS = 20 * 60 * 1000;

export type RunProgress = 'running' | 'did-not-finish' | 'finished';

/** A run is recorded before it starts and only its last write sets finishedAt, so a killed run never finishes. */
export function runProgress(
  run: Pick<DiscoveryRunListItem, 'startedAt' | 'finishedAt'>,
  now: Date = new Date()
): RunProgress {
  if (run.finishedAt) return 'finished';
  return now.getTime() - new Date(run.startedAt).getTime() <= UNFINISHED_RUN_LIMIT_MS ? 'running' : 'did-not-finish';
}

type RunOutcome = Pick<DiscoveryRunListItem, 'status' | 'startedAt' | 'finishedAt' | 'mode'> & {
  sources?: ReadonlyArray<{ ok: boolean }>;
};

/** The Result column: what the run did, in words, with its tone. */
export function runResult(run: RunOutcome, now: Date = new Date()): { label: string; tone: AdminStatusTone } {
  const progress = runProgress(run, now);
  if (progress === 'running') return { label: 'Running', tone: 'info' };
  if (progress === 'did-not-finish') return { label: 'Did not finish', tone: 'bad' };
  if (run.status === 'failed') return { label: 'Failed', tone: 'bad' };
  const lead = run.mode === 'report' ? 'Report only' : 'Finished';
  if (run.status === 'partial') {
    const failed = run.sources?.filter(source => !source.ok).length ?? 0;
    const detail = failed > 0 ? `${failed} ${plural(failed, 'source')} failed` : 'some sources failed';
    return { label: `${lead}, ${detail}`, tone: 'warn' };
  }
  return { label: lead, tone: run.mode === 'report' ? 'neutral' : 'good' };
}

/** The status card's last-run clause, matching the Result column's words for an unfinished run. */
export function lastRunCopy(
  run: Pick<DiscoveryRunListItem, 'startedAt' | 'finishedAt'> & { sources: ReadonlyArray<{ ok: boolean }> },
  now: Date = new Date()
): string {
  const progress = runProgress(run, now);
  const started = formatRunTime(run.startedAt, now);
  if (progress === 'running') return `Last run started ${started}, still running`;
  if (progress === 'did-not-finish') return `Last run ${started}, did not finish`;
  return `Last run ${started}, ${sourceTally(run.sources)}`;
}

/** The Summary column, from a listed run's counts. */
export function runChangeSummary(changes: DiscoveryChangeCounts, mode: DiscoveryRunListItem['mode']): string {
  const parts = [
    changes.added > 0 && `${changes.added} new ${plural(changes.added, 'model')}`,
    changes.promoted > 0 && `${changes.promoted} listed`,
    changes.repriced > 0 && `${changes.repriced} repriced`,
    changes.flagged > 0 && `${changes.flagged} ${plural(changes.flagged, 'price')} to review`,
    changes.deprecated > 0 && `${changes.deprecated} lifecycle ${plural(changes.deprecated, 'change')}`,
  ].filter((part): part is string => !!part);
  if (parts.length === 0) return 'No changes';
  const summary = capitalize(parts.join(', '));
  return mode === 'report' ? `${summary} (not saved)` : summary;
}

/** "4 of 5 sources ok": attempts only, so a skipped source never reads as a failure. */
export function sourceTally(sources: ReadonlyArray<{ ok: boolean }>): string {
  if (sources.length === 0) return 'no sources attempted';
  const ok = sources.filter(source => source.ok).length;
  return `${ok} of ${sources.length} ${plural(sources.length, 'source')} ok`;
}

/**
 * Projected from the last scheduled run. Unknown when no scheduled run is on record (preview stages run no cron)
 * or the last one is more than two intervals old, which means the schedule is not running.
 */
export function nextScheduledRun(runs: readonly DiscoveryRunListItem[], now: Date = new Date()): Date | null {
  const lastScheduled = runs.find(run => run.trigger === 'cron');
  if (!lastScheduled) return null;
  const startedAt = new Date(lastScheduled.startedAt).getTime();
  if (Number.isNaN(startedAt) || now.getTime() - startedAt > 2 * SCHEDULE_INTERVAL_MS) return null;
  let next = startedAt + SCHEDULE_INTERVAL_MS;
  while (next <= now.getTime()) next += SCHEDULE_INTERVAL_MS;
  return new Date(next);
}

export const formatClock = (date: Date): string => clock(date);

const PRICE_BLOCKER = 'no-trusted-price';
const APPROVAL_BLOCKER = 'manual-approval-required';
const NOT_CALLABLE = 'We cannot call this model yet: no request profile for it';

const BLOCKER_COPY: Record<string, string> = {
  [PRICE_BLOCKER]: 'No price yet. New models list once they have a price.',
  [APPROVAL_BLOCKER]: 'Waiting for your approval',
  'no-credential-for-backend': 'No key for its provider is configured in this environment',
  'disabled-by-source': 'The provider lists it as unavailable',
  'no-adapter-family': NOT_CALLABLE,
  'family-not-dispatchable': NOT_CALLABLE,
  'no-dispatch-profile': NOT_CALLABLE,
  'incomplete-dispatch-profile': NOT_CALLABLE,
};

/** A promotion blocker (PromotionBlocker in the discovery service) in plain words. */
export const blockerCopy = (code: string): string => BLOCKER_COPY[code] ?? 'Not listed by this run';

/** Blockers an admin settles in the console: they put a model under Needs your decision rather than Hidden. */
export const isDecisionBlocker = (code: string): boolean => code === PRICE_BLOCKER || code === APPROVAL_BLOCKER;

const FLAG_COPY: Record<string, string> = {
  'band-exceeded': 'Proposed price is outside the allowed band around the current one',
  'source-disagreement': 'Sources disagree on this price',
  'single-source-untrusted': 'Only one untrusted source quoted this price',
  'operator-owned-divergence': 'A source now differs from the price an admin set',
  'tiered-pricing-manual': 'This model has tiered pricing that must be entered by hand',
};
// The flag stores no band; its detail line ends "(band 50%): ..." (pricePlan.ts in the discovery service), which is
// the band the run applied, not today's setting.
const BAND_IN_DETAIL = /\(band (\d+)%\)/;

export const flagCopy = (kind: string, detail = ''): string => {
  const band = kind === 'band-exceeded' ? BAND_IN_DETAIL.exec(detail)?.[1] : undefined;
  if (band !== undefined) return `Proposed price is more than ${band}% away from the current one`;
  return FLAG_COPY[kind] ?? 'Discovery did not apply this price';
};

const PRICE_SKIP_COPY: Record<string, string> = {
  'unknown-model': 'Not a model this build knows',
  'operator-owned': 'Price set by an admin',
  'tiered-pricing': 'Tiered pricing, entered by hand',
  untrusted: 'Source not trusted on its own',
  unchanged: 'Price unchanged',
};
export const priceSkipCopy = (reason: string): string => PRICE_SKIP_COPY[reason] ?? reason;

const SOURCE_SKIP_COPY: Record<string, string> = {
  'not-configured': 'not configured',
  'egress-disabled': 'outbound calls are off',
  'recently-fetched': 'fetched recently',
  'global-deadline': 'the run ran out of time',
};
export const sourceSkipCopy = (reason: string): string => SOURCE_SKIP_COPY[reason] ?? reason;

const SIGNAL_COPY: Record<string, string> = {
  typed: 'Provider feed',
  absence: 'Missing from provider listings',
};
export const signalCopy = (signal: string): string => SIGNAL_COPY[signal] ?? signal;

export const lifecycleWord = (status: string | undefined): string => (status ? capitalize(status) : 'None');

const STATUS_COPY: Record<AdminModelStatus, { label: string; tone: AdminStatusTone }> = {
  listed: { label: 'Listed', tone: 'good' },
  limited: { label: 'Limited', tone: 'neutral' },
  'needs-review': { label: 'Needs review', tone: 'warn' },
  hidden: { label: 'Hidden', tone: 'neutral' },
  retiring: { label: 'Retiring', tone: 'warn' },
  retired: { label: 'Retired', tone: 'neutral' },
};
export const modelStatusCopy = (status: AdminModelStatus) => STATUS_COPY[status];

const PROBLEM_COPY: Record<StaleReferenceProblem, { label: string; tone: AdminStatusTone }> = {
  deprecated: { label: 'Deprecated', tone: 'warn' },
  retired: { label: 'Retired', tone: 'bad' },
  // The catalog knows the id but no configured key lists it, so routing to it fails like an unknown id.
  'not-invocable': { label: 'Not callable', tone: 'warn' },
  unknown: { label: 'Unknown model', tone: 'neutral' },
};
export const problemCopy = (problem: string): { label: string; tone: AdminStatusTone } =>
  PROBLEM_COPY[problem as StaleReferenceProblem] ?? { label: problem, tone: 'neutral' };

/** Rates arrive per 1M tokens, the unit prices are read in. */
export const usdPerMTok = (value: number | undefined): string =>
  value === undefined ? '-' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;

export const inOut = (rates: PerMTokRates | undefined): string =>
  rates ? `${usdPerMTok(rates.inputPerMTok)} in / ${usdPerMTok(rates.outputPerMTok)} out` : '-';

/** The published brackets a flat row does not carry, e.g. "$5 in / $22.5 out above 272,000 tokens". */
export const longContextBrackets = (brackets: ReadonlyArray<PerMTokRates & { aboveTokens: number }>): string =>
  brackets.map(bracket => `${inOut(bracket)} above ${bracket.aboveTokens.toLocaleString('en-US')} tokens`).join('; ');

/** A capped detail array's count, which never passes the stored slice off as the whole set. */
export const countLabel = (shown: number, total: number | undefined): string =>
  total !== undefined && total > shown ? `first ${shown} of ${total}` : `${shown}`;

/** "Found 2 new models. Listed 1. 1 needs a price. Repriced 3. 1 price needs review." */
export function runSentence(run: DiscoveryRun): string {
  const wrote = run.mode === 'write';
  const { changes } = run;
  const blockedNew = (code: string) =>
    run.catalogDiff.filter(entry => entry.kind === 'added' && !entry.promoted && entry.blockedBy.includes(code)).length;
  const needsPrice = blockedNew(PRICE_BLOCKER);
  const awaitingApproval = blockedNew(APPROVAL_BLOCKER);
  const failedSources = run.sources.filter(source => !source.ok).length;
  const parts = [
    changes.added.length > 0 && `Found ${changes.added.length} new ${plural(changes.added.length, 'model')}.`,
    changes.promoted.length > 0 && `${wrote ? 'Listed' : 'Would list'} ${changes.promoted.length}.`,
    needsPrice > 0 && `${needsPrice} ${plural(needsPrice, 'needs', 'need')} a price.`,
    awaitingApproval > 0 && `${awaitingApproval} ${plural(awaitingApproval, 'waits', 'wait')} for approval.`,
    changes.repriced.length > 0 && `${wrote ? 'Repriced' : 'Would reprice'} ${changes.repriced.length}.`,
    changes.flagged.length > 0 &&
      `${changes.flagged.length} ${plural(changes.flagged.length, 'price needs', 'prices need')} review.`,
    changes.deprecated.length > 0 &&
      `${changes.deprecated.length} lifecycle ${plural(changes.deprecated.length, 'change')}.`,
    failedSources > 0 && `${failedSources} ${plural(failedSources, 'source')} failed.`,
  ].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' ') : 'No changes.';
}
