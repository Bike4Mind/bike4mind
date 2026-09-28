#!/usr/bin/env node
/**
 * One-off backfill for the admin /status page: replays the E2E and AI Latency bot
 * posts in a Slack channel as QA runs (source 'slack-backfill': counts, suites,
 * credits, latency; no tests or media) through POST /api/v1/qa/runs, the same
 * contract, qaRunFromWire and ingestRun path the CI ingest uses (contract:
 * b4m-core/common/src/api-contract/contracts/qa.contract.ts).
 *
 * Only the current formats parse: "Parse credits" + "Notify Slack" in
 * .github/workflows/e2e-run.yml and "Aggregate results" in
 * .github/workflows/e2e-ai-latency.yml. Anything else is logged and skipped, never
 * guessed. Non-ASCII in the posts is matched through \u escapes so this file stays
 * ASCII. The wire body comes from qa-report.mjs's buildRunPayload, so the two
 * scripts cannot drift on the snake_case shape.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRunPayload, creditsMetrics, latencyMetric, withRetry } from './qa-report.mjs';

const BULLET = '\u2022';
const CREDITS_SEP = ' \u2014 credits: ';
const FENCE = '```';

const E2E_HEADER = /^Playwright E2E (.+) \(([^()]+)\)$/;
const LATENCY_HEADER = /^AI Latency \(([^()]+)\)$/;
const RESULTS =
  /^:white_check_mark: (\d+) passed +:x: (\d+) failed +:fast_forward: (\d+) skipped +:no_entry_sign: (\d+) not started +Total: (\d+)$/;
const ENV_LINK = /^<[^|<>]+\|([^<>]+)>$/;
const BRANCH = /^`([^`]+)`$/;
const SUITE_PREFIX = /^:[a-z0-9_+-]+: /;
const SUITE_COUNTS = /^(\d+)\/(\d+)(?: \((\d+) did not run\))?$/;
const CREDITS_VALUE = /^\d+(?:\.\d+)?$/;
// printf '%.2fs / <=%ss' plus the breach suffixes, or N/A when the spec declares no threshold.
const LATENCY_CELL = /^(\d+\.\d{2})s \/ <=(?:N\/A|(\d+(?:\.\d+)?)s)(?: FAIL(?: \(\d+ prompt\(s\) never finished\))?)?$/;
const TABLE_RULE = /^[- ]+$/;
const QUALITY = new Set(['Pass', 'Fail', '---']);
const RUN_PATH = /^\/[^/]+\/[^/]+\/actions\/runs\/\d+$/;
const SLACK_TS = /^\d+\.\d+$/;

class Unparseable extends Error {}
const fail = reason => {
  throw new Unparseable(reason);
};
const clip = s => String(s).slice(0, 80);

/** Slack stores literal &, < and > in message text as HTML entities. */
const unescapeSlack = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Every text string in a message's blocks, in order. */
export function blockText(message) {
  const out = [];
  for (const block of message?.blocks ?? []) {
    if (typeof block?.text?.text === 'string') out.push(block.text.text);
    for (const field of block?.fields ?? []) if (typeof field?.text === 'string') out.push(field.text);
  }
  return out;
}

/** "*Label*\nbody" sections and fields, keyed by label. */
function labelledSections(message) {
  const out = new Map();
  for (const text of blockText(message)) {
    const nl = text.indexOf('\n');
    const head = nl === -1 ? text : text.slice(0, nl);
    if (head.length > 2 && head.startsWith('*') && head.endsWith('*')) {
      out.set(head.slice(1, -1), nl === -1 ? '' : text.slice(nl + 1));
    }
  }
  return out;
}

const sectionEndingWith = (sections, suffix) => [...sections].find(([label]) => label.endsWith(suffix))?.[1];

/** The "View Report" / "View Run" button, minus its #artifacts anchor. */
function runLink(message) {
  for (const block of message?.blocks ?? []) {
    if (block?.type !== 'actions') continue;
    for (const el of block.elements ?? []) {
      let url;
      try {
        url = new URL(el?.url);
      } catch {
        continue;
      }
      if (url.protocol === 'https:' && RUN_PATH.test(url.pathname)) return `${url.origin}${url.pathname}`;
    }
  }
  return null;
}

function parseIdentity(message, sections) {
  const ts = typeof message?.ts === 'string' && SLACK_TS.test(message.ts) ? message.ts : fail('no message ts');
  const branch = BRANCH.exec(sections.get('Branch') ?? '')?.[1] ?? fail('no Branch field');
  const envLabel = ENV_LINK.exec(sections.get('Environment') ?? '')?.[1] ?? fail('no Environment field');
  return {
    ts,
    tsMs: Math.round(Number(ts) * 1000),
    branch: unescapeSlack(branch),
    env: unescapeSlack(envLabel).trim().toLowerCase(),
    ciRunUrl: runLink(message) ?? fail('no Actions run link'),
  };
}

function parseSuiteLines(body) {
  // The results parser's stand-in when pw-results.json is missing.
  if (body === '' || body === '_No results available_') return [];
  return body.split('\n').map(line => {
    const prefix = SUITE_PREFIX.exec(line)?.[0] ?? fail(`bad suite line "${clip(line)}"`);
    const sep = line.lastIndexOf(': ');
    const counts = (sep > prefix.length && SUITE_COUNTS.exec(line.slice(sep + 2))) || fail(`bad suite line "${clip(line)}"`);
    return {
      name: unescapeSlack(line.slice(prefix.length, sep)),
      passed: Number(counts[1]),
      ran: Number(counts[2]),
      notRun: Number(counts[3] ?? 0),
    };
  });
}

/** Back to credits.json entries, so creditsMetrics maps them exactly as the CI ingest does. */
function parseCredits(body) {
  if (body === '_No credits data available_') return [];
  return body.split('\n').map(line => {
    const sep = line.indexOf(CREDITS_SEP);
    if (!line.startsWith(`${BULLET} `) || sep < 3) fail(`bad credits line "${clip(line)}"`);
    const rest = line.slice(sep + CREDITS_SEP.length);
    const value = rest.split(' ', 1)[0];
    if (!CREDITS_VALUE.test(value) && !rest.startsWith('Credit Used data unavailable')) {
      fail(`bad credits line "${clip(line)}"`);
    }
    return { model: unescapeSlack(line.slice(2, sep)), avgCredits: CREDITS_VALUE.test(value) ? Number(value) : null };
  });
}

function parseE2e(sections, [, name, trigger]) {
  const results = RESULTS.exec(sections.get('Results') ?? '') ?? fail('no Results field in the current format');
  const [passed, failed, skipped, notStarted, total] = results.slice(1).map(Number);
  const summary = sectionEndingWith(sections, ' Run Summary') ?? fail('no Run Summary section');
  const suiteSummary = parseSuiteLines(summary);
  const credits = sectionEndingWith(sections, ' AI Credits');
  // The per-spec sum is the jq's TOTAL_WITH_OK, which is what qa-report.mjs stores as `ran`.
  const ran = suiteSummary.reduce((sum, s) => sum + s.ran, 0);
  return {
    suite: name === 'Tests' ? 'Full' : unescapeSlack(name),
    trigger: unescapeSlack(trigger),
    counts: { passed, failed, skipped, notStarted, ran, total },
    suiteSummary,
    metrics: credits === undefined ? [] : creditsMetrics(parseCredits(credits)),
  };
}

function latencyRows(body) {
  const close = body.indexOf(`\n${FENCE}`);
  if (!body.startsWith(FENCE) || close === -1) fail('Normal Prompts has no table');
  const [head, rule, ...lines] = body.slice(FENCE.length, close).split('\n');
  if (!head.startsWith('Suite ') || !head.endsWith(' Average Latency') || !TABLE_RULE.test(rule ?? '')) {
    fail('Normal Prompts table header changed');
  }
  if (lines.length === 0) fail('Normal Prompts table has no rows');
  return lines.map(line => {
    // Model names contain spaces and can overflow the printf width, so split on the quality token.
    const tokens = line.split(' ').filter(Boolean);
    const q = tokens.findIndex((t, i) => i >= 2 && QUALITY.has(t));
    if (q === -1) fail(`bad latency row "${clip(line)}"`);
    const cell = tokens.slice(q + 1).join(' ');
    const m = cell === 'No Data' ? null : (LATENCY_CELL.exec(cell) ?? fail(`bad latency cell "${clip(cell)}"`));
    return {
      spec: tokens[0],
      model: tokens.slice(1, q).join(' '),
      quality: tokens[q],
      // The Aggregate step's own inputs; "No Data" is averageResponseTimeSec 0 there.
      latency: {
        averageResponseTimeSec: m ? Number(m[1]) : 0,
        ...(m?.[2] !== undefined && { thresholdSec: Number(m[2]) }),
      },
    };
  });
}

function parseLatency(sections, [, trigger]) {
  const body = sections.get('Normal Prompts') ?? fail('no Normal Prompts section');
  const counts = { passed: 0, failed: 0, skipped: 0, notStarted: 0, ran: 0, total: 0 };
  const metrics = [];
  // One row is one spec x model cell; '---' means the cell left no Playwright results.
  for (const { spec, model, quality, latency } of latencyRows(unescapeSlack(body))) {
    if (quality === 'Pass') counts.passed += 1;
    else if (quality === 'Fail') counts.failed += 1;
    else counts.notStarted += 1;
    const metric = latencyMetric(`${spec}-results.json`, { model, ...latency });
    if (metric) metrics.push(metric);
  }
  counts.ran = counts.passed + counts.failed;
  counts.total = counts.ran;
  return { suite: 'AI Latency', trigger: unescapeSlack(trigger), counts, suiteSummary: [], metrics };
}

/**
 * `ctx`: { product, tenant?, channel }. Returns { kind: 'run', run } with the snake_case
 * body QaRunIngestRequestSchema validates, or { kind: 'skipped' | 'unparseable', reason }.
 * externalRunId is slack-<channel>-<ts>: a message's identity, so re-runs upsert.
 */
export function classifySlackPost(message, ctx) {
  try {
    const header = message?.blocks?.find(b => b?.type === 'header')?.text?.text;
    if (typeof header !== 'string') fail('no header block');
    const e2e = E2E_HEADER.exec(header);
    const latency = e2e ? null : LATENCY_HEADER.exec(header);
    if (!e2e && !latency) fail(`unknown header "${clip(header)}"`);
    const sections = labelledSections(message);
    const status = sections.get('Status') ?? fail('no Status field');
    // A preview run that could not start. The CI ingest skips these too ("Ingest QA run (shadow)").
    if (status.startsWith(':fast_forward: Skipped')) {
      return { kind: 'skipped', reason: 'preview run skipped before any test ran' };
    }
    const identity = parseIdentity(message, sections);
    const parsed = e2e ? parseE2e(sections, e2e) : parseLatency(sections, latency);
    const payload = buildRunPayload({
      identity: {
        product: ctx.product,
        tenant: ctx.tenant,
        suite: parsed.suite,
        env: identity.env,
        branch: identity.branch,
        trigger: parsed.trigger,
        ciRunUrl: identity.ciRunUrl,
        sha: '',
        externalRunId: `slack-${ctx.channel}-${identity.ts}`,
      },
      // Post time stands in for the start: the post carries neither a start time nor a duration.
      parsed: { ...parsed, tests: [], startMs: identity.tsMs, endMs: identity.tsMs },
      metrics: parsed.metrics,
    });
    return { kind: 'run', run: { ...payload, source: 'slack-backfill' } };
  } catch (err) {
    if (err instanceof Unparseable) return { kind: 'unparseable', reason: err.message };
    throw err;
  }
}

/** The ingest body for a current-format run post, else null. */
export function parseSlackPost(message, ctx) {
  const result = classifySlackPost(message, ctx);
  return result.kind === 'run' ? result.run : null;
}

const DAY_MS = 86_400_000;
/** Mirrors QA_SLUG_PATTERN in b4m-core/common/src/schemas/qa.ts. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Slack ids are short uppercase alphanumerics; the bound keeps the run id inside QA_EXTERNAL_RUN_ID_PATTERN.
const CHANNEL_ID = /^[A-Z0-9]{1,32}$/;
const SLACK_HISTORY_URL = 'https://slack.com/api/conversations.history';
const SLACK_MAX_ATTEMPTS = 5;
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const USAGE = [
  'usage: node scripts/qa-backfill-slack.mjs --product <slug> --channel <id> --before <iso>',
  '         [--tenant <slug>] [--days 30] [--input history.json] [--dry-run]',
  'env: SLACK_BOT_TOKEN (unless --input), QA_INGEST_URL + QA_INGEST_KEY (unless --dry-run)',
].join('\n');

const VALUE_FLAGS = {
  '--product': 'product',
  '--tenant': 'tenant',
  '--channel': 'channel',
  '--before': 'before',
  '--input': 'input',
};

function parseArgs(argv) {
  const args = { days: 30, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === '--days') args.days = Number(value);
    else if (VALUE_FLAGS[flag]) args[VALUE_FLAGS[flag]] = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  for (const flag of ['--product', '--channel', '--before']) {
    if (!args[VALUE_FLAGS[flag]]) throw new Error(`${flag} is required`);
  }
  if (!SLUG.test(args.product) || (args.tenant !== undefined && !SLUG.test(args.tenant))) {
    throw new Error('--product and --tenant must be lowercase slugs');
  }
  if (!CHANNEL_ID.test(args.channel)) throw new Error('--channel must be a Slack channel id');
  if (Number.isNaN(Date.parse(args.before))) throw new Error('--before must be an ISO 8601 date');
  if (!(args.days > 0)) throw new Error('--days must be positive');
  return args;
}

async function readHistory(file) {
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  const messages = Array.isArray(raw) ? raw : raw?.messages;
  if (!Array.isArray(messages)) throw new Error(`${file}: expected a conversations.history response or a message array`);
  return messages;
}

/** Errors carry Slack's error code only, so the token never reaches a log line. */
async function slackHistory({ token, channel, oldest, latest, fetchImpl, sleep }) {
  const messages = [];
  let cursor = '';
  do {
    const qs = new URLSearchParams({ channel, oldest, latest, limit: '200' });
    if (cursor) qs.set('cursor', cursor);
    let body;
    for (let attempt = 1; !body; attempt++) {
      const res = await fetchImpl(`${SLACK_HISTORY_URL}?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 429 && attempt < SLACK_MAX_ATTEMPTS) {
        // Retry-After is in seconds.
        await sleep((Number(res.headers.get('retry-after')) || 1) * 1000);
        continue;
      }
      const parsed = await res.json().catch(() => null);
      if (!res.ok || !parsed?.ok) throw new Error(`conversations.history failed: ${parsed?.error ?? `HTTP ${res.status}`}`);
      body = parsed;
    }
    messages.push(...(body.messages ?? []));
    cursor = body.has_more ? (body.response_metadata?.next_cursor ?? '') : '';
  } while (cursor);
  return messages;
}

async function postRun(fetchImpl, ingestUrl, apiKey, run) {
  const res = await fetchImpl(`${ingestUrl}/api/v1/qa/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(run),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err = new Error(`POST ${run.external_run_id} -> HTTP ${res.status} ${detail}`.trim());
    // 4xx other than 429 will not change on retry.
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
  return res.json();
}

/**
 * A manual tool, so unlike qa-report.mjs it exits 1 on bad arguments, a failed Slack
 * read, or any run the server did not store. Re-running is safe: runs upsert by id.
 */
export async function main(argv, env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? console;
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    log.warn(`qa-backfill: ${err.message}\n${USAGE}`);
    return 1;
  }
  const ingestUrl = (env.QA_INGEST_URL || '').replace(/\/+$/, '');
  if (!args.input && !env.SLACK_BOT_TOKEN) {
    log.warn(`qa-backfill: set SLACK_BOT_TOKEN or pass --input\n${USAGE}`);
    return 1;
  }
  if (!args.dryRun && (!ingestUrl || !env.QA_INGEST_KEY)) {
    log.warn(`qa-backfill: QA_INGEST_URL and QA_INGEST_KEY are required unless --dry-run\n${USAGE}`);
    return 1;
  }

  const latestMs = Date.parse(args.before);
  const oldestMs = latestMs - args.days * DAY_MS;
  let messages;
  try {
    messages = args.input
      ? await readHistory(args.input)
      : await slackHistory({
          token: env.SLACK_BOT_TOKEN,
          channel: args.channel,
          oldest: String(oldestMs / 1000),
          latest: String(latestMs / 1000),
          fetchImpl,
          sleep,
        });
  } catch (err) {
    log.warn(`qa-backfill: ${err.message}`);
    return 1;
  }

  const ctx = { product: args.product, tenant: args.tenant, channel: args.channel };
  const stats = { parsed: 0, posted: 0, created: 0, failed: 0, skipped: 0, unparseable: 0, ignored: 0 };
  // Oldest first, so runs land in the order they happened.
  const ordered = [...messages].sort((a, b) => Number(a?.ts) - Number(b?.ts));
  for (const message of ordered) {
    const tsMs = Number(message?.ts) * 1000;
    // Webhook posts carry bot_id; people's messages and channel events do not.
    if (!message?.bot_id || !(tsMs >= oldestMs && tsMs < latestMs)) {
      stats.ignored += 1;
      continue;
    }
    const result = classifySlackPost(message, ctx);
    if (result.kind !== 'run') {
      stats[result.kind] += 1;
      log.log(`qa-backfill: ${result.kind} ts=${message.ts}: ${result.reason} | ${clip(message.text ?? '')}`);
      continue;
    }
    stats.parsed += 1;
    const { run } = result;
    const label = `${run.external_run_id} ${run.suite}/${run.env}@${run.branch} ${run.counts.passed}/${run.counts.ran}`;
    if (args.dryRun) {
      log.log(`qa-backfill: would post ${label} ${JSON.stringify(run)}`);
      continue;
    }
    const stored = await withRetry(() => postRun(fetchImpl, ingestUrl, env.QA_INGEST_KEY, run), { sleep, log });
    if (!stored) {
      stats.failed += 1;
      continue;
    }
    stats.posted += 1;
    if (stored.created) stats.created += 1;
    log.log(`qa-backfill: posted ${label} run=${stored.run_id} status=${stored.status} created=${stored.created}`);
  }
  const counts = Object.entries(stats).map(([k, v]) => `${k}=${v}`);
  log.log(`qa-backfill: messages=${messages.length} ${counts.join(' ')}`);
  return stats.failed > 0 ? 1 : 0;
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main(process.argv.slice(2), process.env).then(code => process.exit(code));
