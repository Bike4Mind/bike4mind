import axios from 'axios';
import { QaRun, QaTestResult } from '@bike4mind/database';
import { isKnownFlaky, isPlaceholderValue, type IQaRun, type QaRunStatus, type QaTestStatus } from '@bike4mind/common';
import { Config } from '@server/utils/config';
import { decideAlarm } from './alarm';
import { leadingNonPassing, stateKeyFilter } from './streak';

const ALARM_BRANCH = 'main';
/** Prior runs read per alarm: the streak length cap and the known-flaky history window. */
const STREAK_LOOKBACK = 50;
const FLAKY_LOOKUPS_MAX = 50;
const SLACK_TIMEOUT_MS = 5000;

export interface AlarmDeps {
  post: (webhook: string, text: string) => Promise<void>;
  /** Incoming-webhook URL for a product slug; undefined means log and skip. */
  webhookFor: (product: string) => string | undefined;
  appOrigin: string;
  log: (msg: string) => void;
}

type LeanRun = IQaRun & { _id: unknown };
type PriorRun = { _id: unknown; status: QaRunStatus; startedAt: Date };

/** QA_ALARM_SLACK_WEBHOOKS: JSON `{ "<product slug>": "https://hooks..." }`. Anything unusable is dropped. */
export function parseWebhookMap(raw: string | undefined): Record<string, string> {
  if (!raw || isPlaceholderValue(raw)) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && e[1].startsWith('https://')
      )
    );
  } catch {
    return {};
  }
}

export function defaultAlarmDeps(log: (msg: string) => void): AlarmDeps {
  const raw = Config.QA_ALARM_SLACK_WEBHOOKS;
  const webhooks = parseWebhookMap(raw);
  if (!isPlaceholderValue(raw) && Object.keys(webhooks).length === 0) {
    log('[QA] QA_ALARM_SLACK_WEBHOOKS is set but has no usable https entries; alarms are log-only');
  }
  return {
    post: async (webhook, text) => {
      await axios.post(webhook, { text }, { timeout: SLACK_TIMEOUT_MS });
    },
    webhookFor: product => (Object.hasOwn(webhooks, product) ? webhooks[product] : undefined),
    // APP_URL, not the Host header: the ingest caller controls Host.
    appOrigin: (process.env.APP_URL ?? '').replace(/\/+$/, ''),
    log,
  };
}

/** testKey -> statuses newest first, over the prior runs only (never the run being judged). */
async function flakyHistory(prior: readonly PriorRun[], testKeys: string[]): Promise<Map<string, QaTestStatus[]>> {
  const history = new Map<string, QaTestStatus[]>();
  if (prior.length === 0 || testKeys.length === 0) return history;
  const rows = await QaTestResult.find({ runId: { $in: prior.map(r => String(r._id)) }, testKey: { $in: testKeys } })
    .select('runId testKey status')
    .lean<{ runId: string; testKey: string; status: QaTestStatus }[]>();
  const byRun = new Map<string, typeof rows>();
  for (const row of rows) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
  // Ordered by run startedAt rather than row _id: a re-ingested old run gets fresh _ids.
  for (const run of prior) {
    for (const row of byRun.get(String(run._id)) ?? []) {
      history.set(row.testKey, [...(history.get(row.testKey) ?? []), row.status]);
    }
  }
  return history;
}

/**
 * Compare a freshly ingested run with the previous CI run on main for the same
 * state key and post on a state change. Returns the message (posted or logged).
 * Caller (pages/api/v1/qa/runs.ts) invokes this only when the run was created,
 * so re-ingest never re-posts.
 */
export async function evaluateAlarm(runId: string, deps: AlarmDeps): Promise<string | null> {
  const run = await QaRun.findById(runId).lean<LeanRun>();
  if (!run || run.source !== 'ci' || run.branch !== ALARM_BRANCH) return null;

  // Keyed by product too, so testKeys shared across products never mix (flaky history below).
  const prior = await QaRun.find({ ...stateKeyFilter(run), source: 'ci', startedAt: { $lt: run.startedAt } })
    .sort({ startedAt: -1 })
    .limit(STREAK_LOOKBACK)
    .select('status startedAt')
    .lean<PriorRun[]>();
  const previous = prior[0];

  const failing = await QaTestResult.find({ runId, status: 'failed' })
    .sort({ _id: 1 })
    .select('testKey title')
    .lean<{ testKey: string; title: string }[]>();
  const previousFailing =
    previous?.status === 'failed'
      ? (
          await QaTestResult.find({ runId: String(previous._id), status: 'failed' })
            .select('testKey')
            .lean<{ testKey: string }[]>()
        ).map(t => t.testKey)
      : [];

  // Newly failing tests first: they are the ones a "now also failing" post names.
  const before = new Set(previousFailing);
  const lookups = [...failing.filter(t => !before.has(t.testKey)), ...failing.filter(t => before.has(t.testKey))]
    .slice(0, FLAKY_LOOKUPS_MAX)
    .map(t => t.testKey);
  const history = await flakyHistory(prior, lookups);
  const knownFlaky = new Set(lookups.filter(k => isKnownFlaky(history.get(k) ?? [])));

  const message = decideAlarm({
    key: { suite: run.suite, env: run.env, ...(run.tenant ? { tenant: run.tenant } : {}) },
    runUrl: `${deps.appOrigin}/status/runs/${runId}`,
    previous: previous ? { status: previous.status, failing: previousFailing } : null,
    current: { status: run.status, failing, ran: run.counts.ran, notStarted: run.counts.notStarted },
    priorNonPassing: leadingNonPassing(prior).count,
    knownFlaky,
  });
  if (!message) return null;

  const webhook = deps.webhookFor(run.product);
  if (!webhook) deps.log(`[QA] alarm not posted (no webhook for ${run.product}): ${message}`);
  else await deps.post(webhook, message);
  return message;
}
