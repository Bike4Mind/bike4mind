import { createHash } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PinnedFetchError, createPinnedFetch } from '@bike4mind/fab-pipeline/ssrf';

// A function's data source fetch, through remote MCP's pinned fetch (b4m-core/mcp/src/remote/RemoteMcpClient.ts). The
// source fetch Lambda (infra/callableFunctionSourceFetch.ts) runs it too, so no database, Config, or secrets here.

const CALLABLE_FUNCTION_SOURCE_ERROR_CODES = [
  'source_origin_unlisted',
  'source_blocked',
  'source_redirect_blocked',
  'source_too_large',
  'source_timeout',
  'source_status',
  'source_failed',
] as const;
export type CallableFunctionSourceErrorCode = (typeof CALLABLE_FUNCTION_SOURCE_ERROR_CODES)[number];

export class CallableFunctionSourceError extends Error {
  constructor(
    readonly code: CallableFunctionSourceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CallableFunctionSourceError';
  }
}

export interface CallableFunctionSourceFetchRequest {
  url: string;
  /** The listed data origins; the caller reads the setting, since the fetcher holds no database. */
  origins: string[];
  maxBodyBytes: number;
  timeoutMs: number;
}

export interface CallableFunctionSourceFetchResult {
  body: Buffer;
  sha256: string;
  bytes: number;
  fetchedAt: string;
}

export type CallableFunctionSourceFetcher = (
  request: CallableFunctionSourceFetchRequest
) => Promise<CallableFunctionSourceFetchResult>;

/** TEST ONLY: plain http on loopback. The pinned fetch throws when this is set outside vitest. */
export interface CallableFunctionSourceFetchTestOnly {
  allowLoopbackHttp?: boolean;
}

const CALLABLE_FUNCTION_SOURCE_MAX_REDIRECTS = 3;
export const CALLABLE_FUNCTION_SOURCE_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_URL_CHARS = 2048;

const PINNED_CODES: Record<PinnedFetchError['code'], CallableFunctionSourceErrorCode> = {
  ssrf_blocked: 'source_blocked',
  scheme_blocked: 'source_blocked',
  redirect_blocked: 'source_redirect_blocked',
  too_many_redirects: 'source_redirect_blocked',
  size_cap: 'source_too_large',
  timeout: 'source_timeout',
};

const MESSAGES: Record<CallableFunctionSourceErrorCode, string> = {
  source_origin_unlisted: 'The source is not on a listed data origin.',
  source_blocked: 'The source resolves to an address that is not allowed.',
  source_redirect_blocked: 'The source redirected somewhere it may not.',
  source_too_large: 'The source is larger than the data file limit or the 4 MB a source fetch can return.',
  source_timeout: 'The source did not answer in time.',
  source_status: 'The source did not answer with its data.',
  source_failed: 'The source could not be read.',
};

const sourceError = (code: CallableFunctionSourceErrorCode) => new CallableFunctionSourceError(code, MESSAGES[code]);

function toSourceError(error: unknown, violation: PinnedFetchError | undefined): CallableFunctionSourceError {
  if (error instanceof CallableFunctionSourceError) return error;
  if (violation) return sourceError(PINNED_CODES[violation.code]);
  if (error instanceof PinnedFetchError) return sourceError(PINNED_CODES[error.code]);
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return sourceError('source_timeout');
  }
  return sourceError('source_failed');
}

// One GET on a listed origin: private addresses refused on every connection, at most three same-origin redirects,
// the body within `maxBodyBytes`, and the whole request within `timeoutMs`.
export async function fetchCallableFunctionSource(
  request: CallableFunctionSourceFetchRequest,
  testOnly: CallableFunctionSourceFetchTestOnly = {}
): Promise<CallableFunctionSourceFetchResult> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw sourceError('source_origin_unlisted');
  }
  if (!request.origins.includes(url.origin)) throw sourceError('source_origin_unlisted');

  const loopback = testOnly.allowLoopbackHttp === true;
  let violation: PinnedFetchError | undefined;
  const pinned = createPinnedFetch({
    allowHttp: loopback,
    maxBodyBytes: request.maxBodyBytes,
    timeoutMs: Math.min(request.timeoutMs, MAX_TIMEOUT_MS),
    maxRedirects: CALLABLE_FUNCTION_SOURCE_MAX_REDIRECTS,
    sameOriginRedirectsOnly: true,
    onViolation: error => {
      violation ??= error;
    },
    testOnlyAllowLoopback: loopback,
  });
  try {
    const response = await pinned(url, { redirect: 'follow', headers: { accept: '*/*' } });
    if (!response.ok) {
      await response.body?.cancel();
      throw sourceError('source_status');
    }
    const body = Buffer.from(await response.arrayBuffer());
    return {
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: body.length,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    throw toSourceError(error, violation);
  } finally {
    await pinned.close();
  }
}

/** Names the fetch Lambda; when unset, sources are fetched in this process (tests, local development, self-host). */
const CALLABLE_FUNCTION_SOURCE_FETCH_NAME_ENV = 'CALLABLE_FUNCTION_SOURCE_FETCH_FUNCTION_NAME';

/** What one Lambda reply carries once base64 encoded, under the 6 MB synchronous response limit. */
export const CALLABLE_FUNCTION_SOURCE_LAMBDA_MAX_BYTES = 4 * 1024 * 1024;

export type CallableFunctionSourceLambdaReply =
  | { ok: true; body: string; sha256: string; bytes: number; fetchedAt: string }
  | { ok: false; code: CallableFunctionSourceErrorCode };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const CODES: ReadonlySet<string> = new Set(CALLABLE_FUNCTION_SOURCE_ERROR_CODES);

/** The Lambda's side: checks the payload's shape, fetches, and answers with a value rather than a throw. */
export async function runCallableFunctionSourceFetchForLambda(
  event: unknown,
  fetcher: CallableFunctionSourceFetcher = request => fetchCallableFunctionSource(request)
): Promise<CallableFunctionSourceLambdaReply> {
  if (
    !isObject(event) ||
    typeof event.url !== 'string' ||
    event.url.length > MAX_URL_CHARS ||
    !Array.isArray(event.origins) ||
    event.origins.length > 10 ||
    !event.origins.every(origin => typeof origin === 'string') ||
    typeof event.maxBodyBytes !== 'number' ||
    !Number.isSafeInteger(event.maxBodyBytes) ||
    event.maxBodyBytes < 1 ||
    typeof event.timeoutMs !== 'number' ||
    !(event.timeoutMs > 0)
  ) {
    throw new Error('Invalid source fetch payload');
  }
  try {
    const result = await fetcher({
      url: event.url,
      origins: event.origins as string[],
      maxBodyBytes: Math.min(event.maxBodyBytes, CALLABLE_FUNCTION_SOURCE_LAMBDA_MAX_BYTES),
      timeoutMs: Math.min(event.timeoutMs, MAX_TIMEOUT_MS),
    });
    const { sha256, bytes, fetchedAt } = result;
    return { ok: true, body: result.body.toString('base64'), sha256, bytes, fetchedAt };
  } catch (error) {
    return { ok: false, code: toSourceError(error, undefined).code };
  }
}

let defaultLambdaClient: LambdaClient | undefined;
const sendWithDefaultClient = (command: InvokeCommand) =>
  (defaultLambdaClient ??= new LambdaClient({ maxAttempts: 1 })).send(command);

const FAILED_MESSAGE = 'Callable function source fetch invocation failed';

/** Invokes the fetch Lambda; the reply's bytes are hashed again here, so a reply that disagrees is refused. */
export function createLambdaCallableFunctionSourceFetcher(
  functionName: string,
  send: (command: InvokeCommand) => Promise<{ FunctionError?: string; Payload?: Uint8Array }> = sendWithDefaultClient
): CallableFunctionSourceFetcher {
  const failed = (cause?: string) => new Error(FAILED_MESSAGE, { cause });
  return async request => {
    let reply: { FunctionError?: string; Payload?: Uint8Array };
    try {
      reply = await send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(JSON.stringify(request)),
        })
      );
    } catch (error) {
      throw failed(error instanceof Error ? error.name : 'unknown');
    }
    if (reply.FunctionError) throw failed(`FunctionError: ${reply.FunctionError}`);
    if (!reply.Payload) throw failed('no payload');
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(reply.Payload).toString('utf8'));
    } catch (error) {
      throw failed(error instanceof Error ? error.name : 'unknown');
    }
    if (isObject(body) && body.ok === false && typeof body.code === 'string' && CODES.has(body.code)) {
      throw sourceError(body.code as CallableFunctionSourceErrorCode);
    }
    if (!isObject(body) || body.ok !== true || typeof body.body !== 'string' || typeof body.fetchedAt !== 'string') {
      throw failed('malformed reply');
    }
    const bytes = Buffer.from(body.body, 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== body.sha256 || bytes.length !== body.bytes || bytes.length > request.maxBodyBytes) {
      throw failed('reply does not match');
    }
    return { body: bytes, sha256, bytes: bytes.length, fetchedAt: body.fetchedAt };
  };
}

/** The Lambda fetcher when the environment names it, this process otherwise. */
export function selectCallableFunctionSourceFetcher(
  env: NodeJS.ProcessEnv = process.env
): CallableFunctionSourceFetcher {
  const functionName = env[CALLABLE_FUNCTION_SOURCE_FETCH_NAME_ENV];
  return functionName
    ? createLambdaCallableFunctionSourceFetcher(functionName)
    : request => fetchCallableFunctionSource(request);
}
