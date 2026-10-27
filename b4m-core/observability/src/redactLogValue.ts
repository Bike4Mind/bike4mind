const REDACTED = '[REDACTED]';
const TRUNCATED = '[Truncated]';
/** Deep or wide enough that a log line would be unreadable anyway; bounds cost as well as output. */
const MAX_DEPTH = 8;
const MAX_NODES = 2000;

const sensitiveSuffix =
  /(?:secret|token|password|apikey|body|bodypreview|prompt|promptpreview|parameterspreview|toolresult|preview|snippet)$/i;
const sensitiveField =
  /^(authorization|proxyAuthorization|cookie|setCookie|headers|config|request|response|body|requestBody|responseBody|data|message|messages|conversation|conversationHistory|prompt|systemPrompt|content|text|toolResult|toolResults|arguments|parameters|parametersPreview|fullChunk|result|password|securityQuestions|userNotes|apiKey|xiApiKey|xKey|token|accessToken|refreshToken|clientSecret|signingSecret|secret|previousKey)$/i;

function redactString(value: string): string {
  return value.replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`);
}

interface WalkState {
  seen: WeakSet<object>;
  nodes: number;
}

/**
 * The request id that ties a provider failure to the provider's own logs. Kept because it is the
 * one field an operator needs to ask the provider what went wrong, and it carries no secret.
 */
function requestIdOf(value: object): string | undefined {
  const record = value as Record<string, unknown>;
  for (const field of ['request_id', 'requestID', 'requestId']) {
    const id = record[field];
    if (typeof id === 'string' && id) return id;
  }
  const metadata = record.$metadata as { requestId?: unknown } | undefined;
  if (typeof metadata?.requestId === 'string' && metadata.requestId) return metadata.requestId;
  // Axios puts response headers under `response.headers`; some SDKs keep them on the error itself.
  for (const container of [record.response, record]) {
    const headers = (container as { headers?: Record<string, unknown> } | undefined)?.headers;
    const header = headers?.['x-request-id'];
    if (typeof header === 'string' && header) return header;
  }
  return undefined;
}

/**
 * Errors thrown by the model and cloud SDKs (axios config/response, AWS `$metadata`) put the
 * request and response bodies on the error object. Keeping only the safe fields means an incident
 * log still says WHAT failed ("context length exceeded") without serializing the payload.
 */
function redactProviderError(value: Error, state: WalkState, depth: number): unknown {
  const record = value as Error & { code?: unknown; status?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const status =
    typeof record.status === 'number'
      ? record.status
      : typeof record.$metadata?.httpStatusCode === 'number'
        ? record.$metadata.httpStatusCode
        : undefined;
  return {
    name: value.name,
    message: redactString(value.message),
    code: typeof record.code === 'string' ? record.code : undefined,
    status,
    requestId: requestIdOf(value),
    ...causeField(value, state, depth),
  };
}

/**
 * `cause` is non-enumerable when set through the Error constructor, so spreading an Error drops it -
 * and with undici the cause is the only place the real network reason (ECONNRESET, ENOTFOUND, ...)
 * lives. Walked like any nested value, so MAX_DEPTH and the circular guard bound a cause chain.
 */
function causeField(value: Error, state: WalkState, depth: number): { cause?: unknown } {
  const { cause } = value as Error & { cause?: unknown };
  return cause === undefined ? {} : { cause: walk(cause, state, depth + 1) };
}

function isProviderError(value: Error): boolean {
  return (
    ('status' in value && typeof (value as { status?: unknown }).status === 'number') ||
    ['isAxiosError', 'headers', 'request_id', 'requestID', 'response', 'config', '$metadata', '$response'].some(
      field => field in value
    )
  );
}

/** Normalize the key once so `api_key`, `apiKey` and `api-key` all reach the same tests. */
function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '');
  return sensitiveField.test(normalized) || sensitiveSuffix.test(normalized);
}

function redactEntry(key: string, value: unknown, state: WalkState, depth: number): unknown {
  return isSensitiveKey(key) ? REDACTED : walk(value, state, depth + 1);
}

function walk(value: unknown, state: WalkState, depth: number): unknown {
  if (++state.nodes > MAX_NODES) return TRUNCATED;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (state.seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return TRUNCATED;
  state.seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (typeof Buffer !== 'undefined' && value instanceof Buffer) return `<Buffer ${value.length} bytes>`;
    if (value instanceof Map) {
      // Map keys are field names exactly as object keys are, so they go through the same test.
      const entries: Record<string, unknown> = {};
      for (const [key, entry] of value) entries[String(key)] = redactEntry(String(key), entry, state, depth);
      return entries;
    }
    if (value instanceof Set) return [...value].map(entry => walk(entry, state, depth + 1));
    if (Array.isArray(value)) return value.map(entry => walk(entry, state, depth + 1));
    if (value instanceof Error) {
      if (isProviderError(value)) return redactProviderError(value, state, depth);
      // An own enumerable `cause` (assigned after construction) is walked once, by causeField.
      const own = { ...value } as Record<string, unknown>;
      delete own.cause;
      const fields = walk(own, state, depth + 1) as Record<string, unknown>;
      return {
        ...fields,
        ...causeField(value, state, depth),
        name: value.name,
        message: redactString(value.message),
        stack: redactString(value.stack ?? ''),
      };
    }
    // Honour a `toJSON` (ObjectId, mongoose document, ...) before walking own entries: their raw
    // internals carry no information anyone reads in a log line.
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      const json = (toJSON as () => unknown).call(value);
      if (json !== value) return walk(json, state, depth + 1);
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (typeof field === 'function') continue;
      sanitized[key] = redactEntry(key, field, state, depth);
    }
    return sanitized;
  } catch {
    return '[Unserializable]';
  } finally {
    state.seen.delete(value);
  }
}

/** Sanitize before formatting so JSON, pretty and plain output share the same boundary. */
export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  return walk(value, { seen, nodes: 0 }, 0);
}
