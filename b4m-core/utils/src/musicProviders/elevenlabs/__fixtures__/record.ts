/**
 * One-off recorder for the ElevenLabs music adapter fixtures. Spends real money ($0.15 per output minute):
 * run only after a human has supplied ELEVENLABS_API_KEY and approved the spend.
 *
 *   BLOCKED_PROMPT='<prompt naming a real artist>' pnpm --filter @bike4mind/scripts exec tsx \
 *     --env-file=<file with ELEVENLABS_API_KEY> \
 *     "$PWD/b4m-core/utils/src/musicProviders/elevenlabs/__fixtures__/record.ts" [scenario ...]
 *
 * With no arguments every scenario runs; name scenarios to re-record only those. `blocked` and `invalid-param`
 * are refused before generation and cost nothing.
 *
 * Binary bytes are never written: every non-JSON part is kept as `{ mimeType, bytes }` (plus `durationSeconds` for
 * MP3), and the test swaps in a synthetic MP3. The JSON part is kept verbatim. A refusal's prompt suggestion is
 * redacted, since it can describe the very artist it refused.
 */
import { writeFileSync } from 'node:fs';
import type { MusicGenerationRequest, ValidatedMusicRequest } from '@bike4mind/common';
import { assertNoSecret } from '../../../videoProviders/geminiOmni/__fixtures__/scrub';
import { mp3DurationSeconds } from '../../mp3Duration';
import { boundaryOf, buildElevenLabsMusicBody, parseMultipart } from '../ElevenLabsMusicProvider';

const BASE = 'https://api.elevenlabs.io';
const PATH = '/v1/music/detailed?output_format=mp3_44100_128';
const apiKey = process.env.ELEVENLABS_API_KEY ?? '';
if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required');

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const mimeTypeOf = (contentType: string) => contentType.split(';')[0].trim().toLowerCase();

const recordParts = (body: Buffer, contentType: string) => {
  const boundary = boundaryOf(contentType);
  const parts = boundary ? parseMultipart(body, boundary) : undefined;
  if (!parts) throw new Error('success response is not a readable multipart body');
  return parts.map(part => {
    const mimeType = mimeTypeOf(part.contentType);
    if (mimeType === 'application/json') {
      return { contentType: part.contentType, body: parseJson(part.body.toString('utf8')) };
    }
    const binary = {
      mimeType: part.contentType,
      bytes: part.body.length,
      ...(mimeType === 'audio/mpeg' && { durationSeconds: mp3DurationSeconds(part.body) }),
    };
    return mimeType.startsWith('audio/')
      ? { contentType: part.contentType, audio: binary }
      : { contentType: part.contentType, binary };
  });
};

const PROMPT_SUGGESTION_REDACTION = '<redacted:prompt-suggestion>';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const redactPromptSuggestion = (body: unknown): unknown => {
  if (!isRecord(body) || !isRecord(body.detail) || !isRecord(body.detail.data)) return body;
  if (!('prompt_suggestion' in body.detail.data)) return body;
  const data = { ...body.detail.data, prompt_suggestion: PROMPT_SUGGESTION_REDACTION };
  return { ...body, detail: { ...body.detail, data } };
};

const call = async (body: unknown) => {
  const started = Date.now();
  const response = await fetch(`${BASE}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const elapsedMs = Date.now() - started;
  const contentType = response.headers.get('content-type') ?? '';
  const multipart = response.ok && contentType.startsWith('multipart/');
  const exchange = {
    name: 'generate',
    request: { method: 'POST', path: PATH, body },
    response: {
      status: response.status,
      headers: {
        'content-type': contentType,
        ...(response.headers.has('song-id') && { 'song-id': '<redacted>' }),
      },
      ...(multipart
        ? { parts: recordParts(bytes, contentType) }
        : { body: redactPromptSuggestion(parseJson(bytes.toString('utf8'))) }),
    },
  };
  return { exchange, elapsedMs };
};

const write = (scenario: string, exchanges: unknown[], extra: Record<string, unknown> = {}) => {
  const fixture = { scenario, recordedAt: new Date().toISOString(), ...extra, exchanges };
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
  assertNoSecret(serialized, apiKey);
  writeFileSync(new URL(`./${scenario}.json`, import.meta.url), serialized);
  process.stdout.write(`wrote ${scenario}.json\n`);
};

const request = (fields: MusicGenerationRequest & { durationSeconds: number; instrumental: boolean }) =>
  fields as ValidatedMusicRequest;

const recordGeneration = async (scenario: string, body: unknown, requestedSeconds: number) => {
  const { exchange, elapsedMs } = await call(body);
  const { status } = exchange.response;
  const audio =
    'parts' in exchange.response
      ? exchange.response.parts.flatMap(part => ('audio' in part ? [part.audio] : []))[0]
      : undefined;
  process.stdout.write(
    `${scenario}: ${status} in ${elapsedMs}ms, ${audio?.durationSeconds ?? '?'}s of ${requestedSeconds}s requested\n`
  );
  if (status >= 400) throw new Error(`${scenario} failed: ${JSON.stringify(exchange.response)}`);
  write(scenario, [exchange], { renderSeconds: Math.round(elapsedMs / 1000), requestedSeconds });
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
  // The body comes from the adapter's own plan builder, so this call also proves the API accepts our plans.
  song: () =>
    recordGeneration(
      'song',
      buildElevenLabsMusicBody(
        request({
          model: 'music_v2_5',
          prompt: 'Warm acoustic folk song, male vocal',
          lyrics:
            '[Verse]\nMorning light on the kitchen floor\nKettle singing by the open door\n' +
            '[Chorus]\nStay a while, stay a while\nThe day can wait for one more smile',
          instrumental: false,
          durationSeconds: 20,
        })
      ),
      20
    ),

  instrumental: () =>
    recordGeneration(
      'instrumental',
      buildElevenLabsMusicBody(
        request({
          model: 'music_v2',
          prompt: 'Upbeat acoustic guitar tune with hand claps',
          instrumental: true,
          durationSeconds: 10,
        })
      ),
      10
    ),

  // Refused with a 400 bad_prompt before any generation, for free. No default, so a real name never lands in the
  // repo; the fixture redacts the prompt.
  blocked: async () => {
    const blockedPrompt = process.env.BLOCKED_PROMPT;
    if (!blockedPrompt) throw new Error('BLOCKED_PROMPT is required for the blocked scenario');
    const { exchange, elapsedMs } = await call(
      buildElevenLabsMusicBody(
        request({ model: 'music_v2_5', prompt: blockedPrompt, instrumental: false, durationSeconds: 10 })
      )
    );
    process.stdout.write(`blocked: ${exchange.response.status} in ${elapsedMs}ms\n`);
    if (exchange.response.status < 400) throw new Error('blocked prompt was generated (and billed); pick another');
    const redacted = redactBlocked([exchange], blockedPrompt);
    if (!Array.isArray(redacted)) throw new Error('redaction changed the exchange list shape');
    write('blocked', redacted);
  },

  // Below the 3 s minimum, so refused before generation, for free.
  'invalid-param': async () => {
    const { exchange, elapsedMs } = await call({
      model_id: 'music_v2_5',
      prompt: 'A short jingle',
      music_length_ms: 1000,
      force_instrumental: true,
    });
    process.stdout.write(`invalid-param: ${exchange.response.status} in ${elapsedMs}ms\n`);
    write('invalid-param', [exchange]);
  },
};

const main = async () => {
  const requested = process.argv.slice(2);
  const unknown = requested.filter(name => !(name in scenarios));
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  for (const name of requested.length > 0 ? requested : Object.keys(scenarios)) await scenarios[name]();
};

await main();
