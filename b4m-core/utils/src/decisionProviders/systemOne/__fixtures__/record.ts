/**
 * Recorder and contract probe for the TypeSafe (systemOne) adapter fixtures. Calls the live API, so it needs a real
 * key and spends a few cents:
 *
 *   pnpm --filter @bike4mind/scripts exec tsx --env-file=<file with TYPESAFE_API_KEY> \
 *     "$PWD/b4m-core/utils/src/decisionProviders/systemOne/__fixtures__/record.ts" [--check] [scenario ...]
 *
 * Optional SYSTEMONE_BASE_URL points it at a self-hosted deployment. Without `--check` it writes the bare vendor
 * response of each scenario to `__fixtures__/systemOne/<scenario>.json` (relative to decisionProviders) and the HTTP
 * status of every scenario to `statuses.json`, dropping that file's `_provisional` marker once all scenarios are
 * recorded. With `--check` nothing is written: each success body must run through the adapter against the live base
 * URL and each error must keep its documented status and envelope; any drift exits non-zero.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Logger } from '@bike4mind/observability';
import { DECISION_MODEL_CATALOG, type DecisionQuestion } from '@bike4mind/common';
import type { DecisionProviderRequest } from '../../types';
import { assertNoSecret } from '../../../videoProviders/veo/__fixtures__/scrub';
import {
  SystemOneDecisionProvider,
  UNKNOWN_MODEL_PREFIX,
  readSystemOneErrorMessage,
  toSystemOneRequestBody,
} from '../SystemOneDecisionProvider';

const BASE_URL = process.env.SYSTEMONE_BASE_URL ?? 'https://api.typesafe.ai';
const apiKey = process.env.TYPESAFE_API_KEY ?? '';
if (!apiKey) throw new Error('TYPESAFE_API_KEY is required');

const FIXTURE_DIR = new URL('../../__fixtures__/systemOne/', import.meta.url);
const STATUSES_FILE = new URL('statuses.json', FIXTURE_DIR);

const MODEL = 'jev-1.13.0';
const TICKET = 'Help, payouts failing since this morning.';
const URGENT: DecisionQuestion = {
  type: 'predicate',
  name: 'is_urgent',
  instructions: 'Is the customer blocked from earning?',
};
const TEAM: DecisionQuestion = {
  type: 'choice',
  name: 'team',
  instructions: 'Which team should handle this?',
  choices: [{ value: 'billing', description: 'Payments and payouts' }, { value: 'technical' }, { value: 'sales' }],
};
const FRUSTRATION: DecisionQuestion = {
  type: 'score',
  name: 'frustration',
  instructions: 'How frustrated is the customer?',
  levels: [{ label: 'calm' }, { label: 'frustrated' }, { label: 'angry' }],
};
const SEVERITY: DecisionQuestion = {
  type: 'score',
  name: 'severity',
  instructions: 'How severe is the problem?',
  levels: [{ label: 'Cosmetic' }, { label: 'Workaround available' }, { label: 'Fully blocked' }],
};
const LANGUAGE: DecisionQuestion = {
  type: 'choice',
  name: 'language',
  instructions: 'Which language is the text written in?',
  choices: ['en', 'de', 'fr', 'es', 'it', 'pt', 'ja'].map(value => ({ value })),
};

const decision = (
  questions: DecisionProviderRequest['questions'],
  input: DecisionProviderRequest['input'] = TICKET
): DecisionProviderRequest => ({ model: MODEL, input, questions });

type Scenario =
  | { name: string; kind: 'success'; request: DecisionProviderRequest }
  | { name: string; kind: 'raw'; body: unknown; status: number; apiKey?: string; messagePrefix?: string };

// `success` scenarios go through the adapter's own request mapping and, under --check, the adapter's parsing.
// `raw` scenarios post a body the adapter cannot produce (or a different key) and pin only the status and envelope.
const SCENARIOS: readonly Scenario[] = [
  { name: 'noul', kind: 'success', request: decision([URGENT]) },
  {
    name: 'noul_criteria',
    kind: 'raw',
    status: 200,
    body: {
      model: MODEL,
      state: TICKET,
      questions: {
        is_urgent: {
          type: 'noul',
          instructions: URGENT.instructions,
          criteria: { true: 'The customer cannot earn money', false: 'The customer can still work' },
        },
      },
    },
  },
  { name: 'choice', kind: 'success', request: decision([TEAM]) },
  { name: 'choice_many', kind: 'success', request: decision([LANGUAGE], 'Ich habe seit gestern ein Problem.') },
  { name: 'score', kind: 'success', request: decision([FRUSTRATION]) },
  { name: 'score_ambiguous', kind: 'success', request: decision([SEVERITY], 'The export button looks off sometimes.') },
  { name: 'multi', kind: 'success', request: decision([URGENT, TEAM, FRUSTRATION]) },
  {
    name: 'state_json',
    kind: 'success',
    request: decision([URGENT], [{ type: 'json', json: { plan: 'pro', open_tickets: 3, payouts_failing: true } }]),
  },
  {
    name: 'state_array',
    kind: 'success',
    request: decision(
      [URGENT],
      [
        { type: 'text', text: TICKET },
        { type: 'json', json: { plan: 'pro' } },
      ]
    ),
  },
  {
    name: 'err_bad_type',
    kind: 'raw',
    status: 400,
    body: { model: MODEL, state: TICKET, questions: { q: { type: 'rank', instructions: 'Rank these.' } } },
  },
  {
    name: 'err_bad_criteria',
    kind: 'raw',
    status: 400,
    body: { model: MODEL, state: TICKET, questions: { q: { type: 'choice', instructions: 'Pick.', criteria: {} } } },
  },
  {
    name: 'err_one_level',
    kind: 'raw',
    status: 200,
    body: {
      model: MODEL,
      state: TICKET,
      questions: { q: { type: 'score', instructions: 'Rate.', criteria: ['only'] } },
    },
  },
  {
    name: 'err_too_many_choices',
    kind: 'raw',
    status: 400,
    body: {
      model: MODEL,
      state: TICKET,
      questions: {
        q: {
          type: 'choice',
          instructions: 'Pick.',
          criteria: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`option_${index}`, null])),
        },
      },
    },
  },
  {
    name: 'err_bad_key',
    kind: 'raw',
    status: 401,
    apiKey: 'ts-invalid-key-for-contract-probe',
    body: toSystemOneRequestBody(decision([URGENT])),
  },
  {
    name: 'err_unknown_model',
    kind: 'raw',
    // The adapter keys its `upstream` mapping on this wording, so a rewording is drift.
    status: 400,
    messagePrefix: UNKNOWN_MODEL_PREFIX,
    body: { ...toSystemOneRequestBody(decision([URGENT])), model: 'jev-0.0.0' },
  },
];

const rawBody = (scenario: Scenario): unknown =>
  scenario.kind === 'success' ? toSystemOneRequestBody(scenario.request) : scenario.body;

const call = async (scenario: Scenario): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${BASE_URL}/v1/systemone`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${scenario.kind === 'raw' && scenario.apiKey ? scenario.apiKey : apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(rawBody(scenario)),
    redirect: 'error',
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
};

const expectedStatus = (scenario: Scenario): number => (scenario.kind === 'raw' ? scenario.status : 200);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// 400s use one of two known envelopes; 401 and 422 are documented with a `detail` key.
const hasKnownErrorEnvelope = (status: number, body: unknown): boolean =>
  status === 400 ? readSystemOneErrorMessage(body) !== undefined : isRecord(body) && 'detail' in body;

const check = async (scenario: Scenario): Promise<string[]> => {
  const drift: string[] = [];
  const { status, body } = await call(scenario);
  if (status !== expectedStatus(scenario)) {
    drift.push(`${scenario.name}: expected HTTP ${expectedStatus(scenario)}, got ${status}`);
  }
  if (status !== 200 && !hasKnownErrorEnvelope(status, body)) {
    drift.push(`${scenario.name}: HTTP ${status} body fits no known error envelope: ${JSON.stringify(body)}`);
  }
  const message = readSystemOneErrorMessage(body);
  if (scenario.kind === 'raw' && scenario.messagePrefix && !message?.startsWith(scenario.messagePrefix)) {
    drift.push(`${scenario.name}: error message no longer starts with "${scenario.messagePrefix}": ${message}`);
  }
  if (scenario.kind === 'success') {
    try {
      await new SystemOneDecisionProvider(BASE_URL).decide(scenario.request, {
        apiKey,
        logger: new Logger(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      drift.push(`${scenario.name}: adapter failed against the live API: ${String(error)}`);
    }
  }
  return drift;
};

// `jev-latest` is an alias; when the vendor moves it the catalog's aliasOf (and the pricing that rides on it) is stale.
const checkAlias = async (): Promise<string[]> => {
  const expected = DECISION_MODEL_CATALOG['jev-latest'].aliasOf;
  try {
    const { model } = await new SystemOneDecisionProvider(BASE_URL).decide(
      { model: 'jev-latest', input: TICKET, questions: [URGENT] },
      { apiKey, logger: new Logger(), signal: AbortSignal.timeout(30_000) }
    );
    if (model === expected) return [];
    return [
      `jev-latest resolved to ${model}, catalog aliasOf is ${expected}: the alias moved, review aliasOf and pricing`,
    ];
  } catch (error) {
    return [`jev-latest alias check failed against the live API: ${String(error)}`];
  }
};

const readStatuses = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(STATUSES_FILE, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const record = async (scenarios: readonly Scenario[]) => {
  const statuses = readStatuses();
  for (const scenario of scenarios) {
    const { status, body } = await call(scenario);
    // A body recorded under an unexpected status would silently replay as the wrong scenario.
    if (status !== expectedStatus(scenario)) {
      throw new Error(`${scenario.name}: expected HTTP ${expectedStatus(scenario)}, got ${status}`);
    }
    const serialized = `${JSON.stringify(body, null, 2)}\n`;
    assertNoSecret(serialized, apiKey);
    writeFileSync(new URL(`${scenario.name}.json`, FIXTURE_DIR), serialized);
    statuses[scenario.name] = status;
    process.stdout.write(`${scenario.name}: HTTP ${status}\n`);
  }
  if (SCENARIOS.every(scenario => scenarios.includes(scenario))) delete statuses._provisional;
  writeFileSync(STATUSES_FILE, `${JSON.stringify(statuses, null, 2)}\n`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const requested = args.filter(arg => arg !== '--check');
  const unknown = requested.filter(name => !SCENARIOS.some(scenario => scenario.name === name));
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  const selected = requested.length > 0 ? SCENARIOS.filter(scenario => requested.includes(scenario.name)) : SCENARIOS;

  if (!checkOnly) {
    await record(selected);
    return;
  }
  // Sequential: the vendor's rate limits are dynamic, and a burst would surface as false drift.
  const drift: string[] = [];
  for (const scenario of selected) drift.push(...(await check(scenario)));
  drift.push(...(await checkAlias()));
  if (drift.length > 0) {
    process.stderr.write(`TypeSafe contract drift detected:\n${drift.map(line => `  - ${line}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`TypeSafe contract OK (${selected.length} scenarios)\n`);
};

await main();
