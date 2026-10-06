/**
 * One-off recorder for the xAI Grok Imagine adapter fixtures. Spends real money (about $0.08 per generated
 * second, 2-second 480p clips by default): run only after a human has supplied XAI_API_KEY and approved the spend.
 *
 *   pnpm --filter @bike4mind/scripts exec tsx --env-file=<repo root>/.env.selfhost \
 *     "$PWD/b4m-core/utils/src/videoProviders/xai/__fixtures__/record.ts" [scenario ...]
 *
 * With no arguments every scenario runs; name scenarios to re-record only those (a billed scenario that
 * failed should be re-run alone, not with the rest). Recordings are written as `<scenario>.json` and win over
 * the `.synthetic.json` stand-ins without any test edit. The bearer key is checked absent from every file
 * before it is written, and the download probe never sends it.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { assertNoSecret, scrubXaiBody } from './scrub';

const BASE = 'https://api.x.ai';
const MODEL = 'grok-imagine-video-1.5';
const POLL_EVERY_MS = 5_000;
const POLL_FOR_MS = 10 * 60_000;
const apiKey = process.env.XAI_API_KEY ?? '';
if (!apiKey) throw new Error('XAI_API_KEY is required');

type Exchange = {
  name: string;
  request: { method: 'GET' | 'POST'; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
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
    request: { method, path, ...(body !== undefined && { body: scrubXaiBody(body) }) },
    response: {
      status: response.status,
      headers: contentType ? { 'content-type': contentType } : {},
      body: scrubXaiBody(parsed),
    },
  };
  return { exchange, parsed };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const statusOf = (value: unknown): string =>
  isRecord(value) && typeof value.status === 'string' ? value.status : 'unknown';
const requestIdOf = (value: unknown): string =>
  isRecord(value) && typeof value.request_id === 'string' ? value.request_id : '';
const videoUrlOf = (value: unknown): string | undefined =>
  isRecord(value) && isRecord(value.video) && typeof value.video.url === 'string' ? value.video.url : undefined;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const pollToTerminal = async (id: string): Promise<{ exchanges: Exchange[]; terminal: unknown }> => {
  const exchanges: Exchange[] = [];
  const deadline = Date.now() + POLL_FOR_MS;
  let first = true;
  while (Date.now() < deadline) {
    const { exchange, parsed } = await call('GET', `/v1/videos/${id}`);
    const status = statusOf(parsed);
    process.stdout.write(`  poll ${exchange.response.status} status=${status}\n`);
    // Auth, throttle and server errors are recorder problems. Any other non-2xx with a body is a provider outcome:
    // a moderated output was seen live as a poll 400 (code "imagine:content-moderated"), so it ends the poll and is saved.
    const httpStatus = exchange.response.status;
    if (httpStatus >= 400 && ([401, 403, 429].includes(httpStatus) || httpStatus >= 500)) {
      throw new Error(`poll of ${id} failed: ${httpStatus} ${JSON.stringify(exchange.response.body)}`);
    }
    if (httpStatus >= 400) {
      exchanges.push({ name: 'poll_terminal', ...exchange });
      return { exchanges, terminal: parsed };
    }
    if (first) exchanges.push({ name: 'poll_first', ...exchange });
    first = false;
    if (status !== 'pending') {
      exchanges.push({ name: 'poll_terminal', ...exchange });
      return { exchanges, terminal: parsed };
    }
    await sleep(POLL_EVERY_MS);
  }
  throw new Error(`request ${id} did not finish in ${POLL_FOR_MS}ms`);
};

// Records whether the pre-signed download answers without credentials; the key is never sent and the bytes are never stored.
const probeDownload = async (url: string): Promise<Exchange> => {
  const response = await fetch(url, { redirect: 'manual' });
  await response.body?.cancel();
  const headers: Record<string, string> = {};
  const contentType = response.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  process.stdout.write(`  download ${response.status}\n`);
  return {
    name: 'download',
    request: { method: 'GET', path: new URL(url).pathname },
    response: { status: response.status, headers },
  };
};

// Cheap by default: 480p, 2 seconds.
const submitBody = (prompt: string, overrides: Record<string, unknown> = {}) => ({
  model: MODEL,
  prompt,
  duration: 2,
  aspect_ratio: '16:9',
  resolution: '480p',
  ...overrides,
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

const recordGeneration = async (scenario: string, body: Record<string, unknown>) => {
  const submit = await call('POST', '/v1/videos/generations', body);
  process.stdout.write(`${scenario}: submit ${submit.exchange.response.status}\n`);
  if (submit.exchange.response.status >= 400) {
    throw new Error(
      `${scenario} submit failed: ${submit.exchange.response.status} ${JSON.stringify(submit.exchange.response.body)}`
    );
  }
  const { exchanges, terminal } = await pollToTerminal(requestIdOf(submit.parsed));
  // The raw (unscrubbed) URL is needed to probe the download; only its scrubbed path is written.
  const url = videoUrlOf(terminal);
  const download = url ? [await probeDownload(url)] : [];
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
    recordGeneration(
      'text-to-video',
      submitBody('A slow dolly shot of a red lighthouse on a rocky coast at dusk, waves breaking.')
    ),

  'image-to-video': () =>
    recordGeneration(
      'image-to-video',
      submitBody('The color slowly ripples like water, camera static.', {
        image: { url: `data:image/png;base64,${solidPng()}` },
      })
    ),

  // Whether moderation rejects at submit (4xx) or later (done + respect_moderation false) is what this records.
  blocked: async () => {
    // Prompt kept generic and redacted in the fixture; override locally if it does not trigger a block.
    const blockedPrompt =
      process.env.BLOCKED_PROMPT ?? 'Extremely graphic, gory footage of a person being violently injured.';
    const blocked = await call('POST', '/v1/videos/generations', submitBody(blockedPrompt));
    process.stdout.write(`blocked: submit ${blocked.exchange.response.status}\n`);
    const exchanges: Exchange[] = [{ name: 'submit', ...blocked.exchange }];
    if (blocked.exchange.response.status < 400) {
      exchanges.push(...(await pollToTerminal(requestIdOf(blocked.parsed))).exchanges);
    }
    const redacted = redactBlocked(exchanges, blockedPrompt);
    if (!Array.isArray(redacted)) throw new Error('redaction changed the exchange list shape');
    write('blocked', redacted);
  },

  // An unsupported aspect ratio is rejected at submit for free.
  'invalid-param': async () => {
    const invalid = await call('POST', '/v1/videos/generations', submitBody('a lighthouse', { aspect_ratio: '1:7' }));
    write('invalid-param', [{ name: 'submit', ...invalid.exchange }]);
  },

  // A bad request id is rejected for free: the live envelope is { code: 'invalid-argument', error: 'Malformed request ID' }.
  'malformed-id': async () => {
    const malformed = await call('GET', '/v1/videos/not-a-real-id');
    write('malformed-id', [{ name: 'poll_terminal', ...malformed.exchange }]);
  },
};

const main = async () => {
  const requested = process.argv.slice(2);
  const unknown = requested.filter(name => !(name in scenarios));
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  for (const name of requested.length > 0 ? requested : Object.keys(scenarios)) await scenarios[name]();
};

await main();
