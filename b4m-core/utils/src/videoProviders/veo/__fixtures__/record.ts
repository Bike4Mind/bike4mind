/**
 * One-off recorder for the Veo adapter fixtures. Spends real money (about $0.10 per generated second at 720p,
 * 4-second clips by default): run only after a human has supplied GEMINI_API_KEY and approved the spend.
 *
 *   pnpm --filter @bike4mind/scripts exec tsx --env-file=<file with GEMINI_API_KEY> \
 *     "$PWD/b4m-core/utils/src/videoProviders/veo/__fixtures__/record.ts" [scenario ...]
 *
 * With no arguments every scenario runs; name scenarios to re-record only those (a billed scenario that
 * failed should be re-run alone, not with the rest). Recordings are written as `<scenario>.json` and win over
 * the `.synthetic.json` stand-ins without any test edit. The key is checked absent from every file before it
 * is written, and the download probe records only status and headers, never the bytes.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { assertNoSecret, scrubBody, scrubUrl } from './scrub';

const BASE = 'https://generativelanguage.googleapis.com';
const MODEL = 'veo-3.1-fast-generate-preview';
const SUBMIT_PATH = `/v1beta/models/${MODEL}:predictLongRunning`;
const POLL_EVERY_MS = 10_000;
const POLL_FOR_MS = 10 * 60_000;
const apiKey = process.env.GEMINI_API_KEY ?? '';
if (!apiKey) throw new Error('GEMINI_API_KEY is required');

type Exchange = {
  name: string;
  request: { method: 'GET' | 'POST'; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
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
  return { exchange, parsed };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const operationNameOf = (value: unknown): string =>
  isRecord(value) && typeof value.name === 'string' ? value.name : '';
const isDone = (value: unknown): boolean => isRecord(value) && value.done === true;

// Depth-first search for the first `video.uri` anywhere in the operation.
const findVideoUri = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUri(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (isRecord(value.video) && typeof value.video.uri === 'string') return value.video.uri;
  return findVideoUri(Object.values(value));
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const pollToTerminal = async (operationName: string): Promise<{ exchanges: Exchange[]; terminal: unknown }> => {
  const exchanges: Exchange[] = [];
  const deadline = Date.now() + POLL_FOR_MS;
  let first = true;
  while (Date.now() < deadline) {
    const { exchange, parsed } = await call('GET', `/v1beta/${operationName}`);
    process.stdout.write(`  poll ${exchange.response.status} done=${isDone(parsed)}\n`);
    // A failed poll is a recorder problem (auth, wrong path), not a provider outcome worth replaying.
    if (exchange.response.status >= 400) {
      throw new Error(`poll failed: ${exchange.response.status} ${JSON.stringify(exchange.response.body)}`);
    }
    if (first) exchanges.push({ name: 'poll_first', ...exchange });
    first = false;
    if (isDone(parsed)) {
      exchanges.push({ name: 'poll_terminal', ...exchange });
      return { exchanges, terminal: parsed };
    }
    await sleep(POLL_EVERY_MS);
  }
  throw new Error(`operation ${operationName} did not finish in ${POLL_FOR_MS}ms`);
};

// Records whether the download needs the key and whether it redirects; never stores the bytes.
const probeDownload = async (uri: string): Promise<Exchange> => {
  const response = await fetch(uri, { headers: { 'x-goog-api-key': apiKey }, redirect: 'manual' });
  const location = response.headers.get('location');
  await response.body?.cancel();
  const headers: Record<string, string> = {};
  const contentType = response.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  if (location) headers.location_host = new URL(location, uri).host;
  process.stdout.write(`  download ${response.status} ${headers.location_host ?? ''}\n`);
  return {
    name: 'download',
    request: { method: 'GET', path: new URL(scrubUrl(uri)).pathname },
    response: { status: response.status, headers },
  };
};

// 4s at 720p is the cheapest valid clip (1080p and 4k need 8s).
const submitBody = (instance: Record<string, unknown>, parameters: Record<string, unknown> = {}) => ({
  instances: [instance],
  parameters: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p', ...parameters },
});

// A 256x256 solid PNG, built here so no binary asset is committed.
const solidPng = (): string => {
  const size = 256;
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(crc32(typed) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x46)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
};

const write = (scenario: string, exchanges: Exchange[]) => {
  const serialized = `${JSON.stringify({ scenario, recordedAt: new Date().toISOString(), exchanges }, null, 2)}\n`;
  assertNoSecret(serialized, apiKey);
  writeFileSync(new URL(`./${scenario}.json`, import.meta.url), serialized);
  process.stdout.write(`wrote ${scenario}.json\n`);
};

const recordGeneration = async (scenario: string, instance: Record<string, unknown>) => {
  const submit = await call('POST', SUBMIT_PATH, submitBody(instance));
  process.stdout.write(`${scenario}: submit ${submit.exchange.response.status}\n`);
  if (submit.exchange.response.status >= 400) {
    throw new Error(
      `${scenario} submit failed: ${submit.exchange.response.status} ${JSON.stringify(submit.exchange.response.body)}`
    );
  }
  const { exchanges, terminal } = await pollToTerminal(operationNameOf(submit.parsed));
  // The raw (unscrubbed) URI is needed to probe the download; only its scrubbed path is written.
  const uri = findVideoUri(terminal);
  const download = uri ? [await probeDownload(uri)] : [];
  write(scenario, [{ name: 'submit', ...submit.exchange }, ...exchanges, ...download]);
};

const BLOCKED_REDACTION = '<redacted:blocked-prompt>';

// Everything echoed back from a blocked request is replaced, so the fixture never carries the prompt text.
const redactBlocked = (value: unknown, prompt: string): unknown => {
  if (Array.isArray(value)) return value.map(item => redactBlocked(item, prompt));
  if (typeof value === 'string') return value.includes(prompt) ? value.split(prompt).join(BLOCKED_REDACTION) : value;
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactBlocked(inner, prompt)]));
};

const scenarios: Record<string, () => Promise<void>> = {
  'text-to-video': () =>
    recordGeneration('text-to-video', {
      prompt: 'A slow dolly shot of a red lighthouse on a rocky coast at dusk, waves breaking.',
    }),

  'image-to-video': () =>
    recordGeneration('image-to-video', {
      prompt: 'The color slowly ripples like water, camera static.',
      image: { inlineData: { mimeType: 'image/png', data: solidPng() } },
    }),

  blocked: async () => {
    // Prompt kept generic and redacted in the fixture; override locally if it does not trigger a block.
    const blockedPrompt =
      process.env.BLOCKED_PROMPT ?? 'Extremely graphic, gory footage of a person being violently injured.';
    const blocked = await call('POST', SUBMIT_PATH, submitBody({ prompt: blockedPrompt }));
    process.stdout.write(`blocked: submit ${blocked.exchange.response.status}\n`);
    const exchanges: Exchange[] = [{ name: 'submit', ...blocked.exchange }];
    if (blocked.exchange.response.status < 400) {
      exchanges.push(...(await pollToTerminal(operationNameOf(blocked.parsed))).exchanges);
    }
    const redacted = redactBlocked(exchanges, blockedPrompt);
    if (!Array.isArray(redacted)) throw new Error('redaction changed the exchange list shape');
    write('blocked', redacted);
  },

  // An unsupported aspect ratio is rejected at submit, before any generation is billed.
  'invalid-param': async () => {
    const invalid = await call('POST', SUBMIT_PATH, submitBody({ prompt: 'a lighthouse' }, { aspectRatio: '1:7' }));
    write('invalid-param', [{ name: 'submit', ...invalid.exchange }]);
  },

  // A GET on a nonexistent operation; free.
  'unknown-operation': async () => {
    const gone = await call('GET', `/v1beta/models/${MODEL}/operations/doesnotexist0000`);
    write('unknown-operation', [{ name: 'poll_terminal', ...gone.exchange }]);
  },
};

const main = async () => {
  const requested = process.argv.slice(2);
  const unknown = requested.filter(name => !(name in scenarios));
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  for (const name of requested.length > 0 ? requested : Object.keys(scenarios)) await scenarios[name]();
};

await main();
