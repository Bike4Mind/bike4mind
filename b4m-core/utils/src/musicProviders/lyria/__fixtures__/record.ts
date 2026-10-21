/**
 * One-off recorder for the Lyria adapter fixtures. Spends real money ($0.08 per lyria-3.5 song, $0.04 per clip):
 * run only after a human has supplied GEMINI_API_KEY and approved the spend.
 *
 *   pnpm --filter @bike4mind/scripts exec tsx --env-file=<file with GEMINI_API_KEY> \
 *     "$PWD/b4m-core/utils/src/musicProviders/lyria/__fixtures__/record.ts" [scenario ...]
 *
 * With no arguments every scenario runs; name scenarios to re-record only those. `blocked` and `invalid-param`
 * are refused before generation and cost nothing. Calls block like the adapter's (no `background`).
 *
 * Audio bytes are never written: the scrubber replaces each base64 `data` with its length, and the test swaps
 * in a synthetic MP3. The measured length, size and type of the real audio are kept under `audio`.
 */
import { writeFileSync } from 'node:fs';
import { assertNoSecret, scrubBody } from '../../../videoProviders/geminiOmni/__fixtures__/scrub';
import { mp3DurationSeconds } from '../../mp3Duration';

const BASE = 'https://generativelanguage.googleapis.com';
const apiKey = process.env.GEMINI_API_KEY ?? '';
if (!apiKey) throw new Error('GEMINI_API_KEY is required');

type Exchange = {
  name: string;
  request: { method: 'GET' | 'POST'; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const statusOf = (value: unknown): string =>
  isRecord(value) && typeof value.status === 'string' ? value.status : 'unknown';

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON error page; kept as text.
  }
  const contentType = response.headers.get('content-type');
  const exchange: Omit<Exchange, 'name'> = {
    request: { method, path, ...(body !== undefined && { body: scrubBody(body) }) },
    response: {
      status: response.status,
      headers: contentType ? { 'content-type': contentType } : {},
      body: scrubBody(parsed),
    },
  };
  return { exchange, parsed, elapsedMs: Date.now() - started };
};

// Depth-first search for the last `{ type: 'audio', data }` block, the one the adapter reads.
const findAudio = (value: unknown): { data: string; mime_type?: unknown } | undefined => {
  if (Array.isArray(value)) return value.map(findAudio).findLast(Boolean);
  if (!isRecord(value)) return undefined;
  if (value.type === 'audio' && typeof value.data === 'string') return { data: value.data, mime_type: value.mime_type };
  return findAudio(Object.values(value));
};

const write = (scenario: string, exchanges: unknown[], extra: Record<string, unknown> = {}) => {
  const fixture = { scenario, recordedAt: new Date().toISOString(), ...extra, exchanges };
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
  assertNoSecret(serialized, apiKey);
  writeFileSync(new URL(`./${scenario}.json`, import.meta.url), serialized);
  process.stdout.write(`wrote ${scenario}.json\n`);
};

const recordGeneration = async (scenario: string, model: string, input: string) => {
  const generate = await call('POST', '/v1beta/interactions', { model, input });
  const { status } = generate.exchange.response;
  process.stdout.write(`${scenario}: ${status} status=${statusOf(generate.parsed)} in ${generate.elapsedMs}ms\n`);
  if (status >= 400) throw new Error(`${scenario} failed: ${JSON.stringify(generate.exchange.response.body)}`);
  const audio = findAudio(generate.parsed);
  const bytes = audio ? Buffer.from(audio.data, 'base64') : undefined;
  write(scenario, [{ name: 'generate', ...generate.exchange }], {
    renderSeconds: Math.round(generate.elapsedMs / 1000),
    audio: bytes && { bytes: bytes.length, mimeType: audio?.mime_type, durationSeconds: mp3DurationSeconds(bytes) },
  });
};

const BLOCKED_REDACTION = '<redacted:blocked-prompt>';

// The prompt is replaced wherever it is echoed back, so the fixture never carries it.
const redactBlocked = (value: unknown, prompt: string): unknown => {
  if (Array.isArray(value)) return value.map(item => redactBlocked(item, prompt));
  if (typeof value === 'string') return value.includes(prompt) ? value.split(prompt).join(BLOCKED_REDACTION) : value;
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactBlocked(inner, prompt)]));
};

const scenarios: Record<string, () => Promise<void>> = {
  song: () =>
    recordGeneration(
      'song',
      'lyria-3.5',
      'A warm indie pop song about a sunny Saturday morning, about 2 minutes long.\n\nLyrics:\n[Verse]\n' +
        'Coffee on the window sill\nThe city waking slow and still\n[Chorus]\nSaturday, Saturday, stay a while\n'
    ),

  'clip-instrumental': () =>
    recordGeneration(
      'clip-instrumental',
      'lyria-3-clip-preview',
      'An upbeat acoustic folk tune with hand claps. Instrumental only, no vocals.'
    ),

  // Refused at once with a 400 prohibited_content, for free. A generic "copyrighted hit in the original singer's
  // voice" prompt was generated (and billed) as a song on 2026-10-13, while one naming a real song and singer was
  // refused. No default, so a real name never lands in the repo; the fixture redacts the prompt.
  blocked: async () => {
    const blockedPrompt = process.env.BLOCKED_PROMPT;
    if (!blockedPrompt) throw new Error('BLOCKED_PROMPT is required for the blocked scenario');
    const blocked = await call('POST', '/v1beta/interactions', { model: 'lyria-3.5', input: blockedPrompt });
    process.stdout.write(`blocked: ${blocked.exchange.response.status}\n`);
    if (blocked.exchange.response.status < 400)
      throw new Error('blocked prompt was generated (and billed); pick another');
    const redacted = redactBlocked([{ name: 'generate', ...blocked.exchange }], blockedPrompt);
    if (!Array.isArray(redacted)) throw new Error('redaction changed the exchange list shape');
    write('blocked', redacted);
  },

  // Lyria takes no output options: an unknown response_format field is refused before generation, for free.
  'invalid-param': async () => {
    const invalid = await call('POST', '/v1beta/interactions', {
      model: 'lyria-3.5',
      input: 'A song',
      response_format: { type: 'audio', duration: '30s' },
    });
    write('invalid-param', [{ name: 'generate', ...invalid.exchange }]);
  },
};

const main = async () => {
  const requested = process.argv.slice(2);
  const unknown = requested.filter(name => !(name in scenarios));
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  for (const name of requested.length > 0 ? requested : Object.keys(scenarios)) await scenarios[name]();
};

await main();
