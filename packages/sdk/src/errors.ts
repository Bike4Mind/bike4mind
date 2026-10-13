import type { components } from './generated/openapi';

type QuestState = components['schemas']['getQuestResponse200'];

/**
 * A non-2xx response. `message` is the envelope's `error` (`ErrorResponse` in the spec); branch on `status` and
 * `errorCode`, never on the prose. The deprecated `name` field is deliberately not surfaced.
 */
export class B4mApiError extends Error {
  readonly status: number;
  readonly errorCode?: string;
  // Body `request_id`, else the `X-Request-ID` header; quote it in support requests.
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  // Parsed JSON when the body was JSON, else the raw text (an HTML error page, an empty string).
  readonly body: unknown;
  readonly headers: Headers;

  constructor(status: number, body: unknown, headers: Headers) {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    super(typeof record.error === 'string' ? record.error : `HTTP ${status}`);
    this.name = 'B4mApiError';
    this.status = status;
    this.body = body;
    this.headers = headers;
    if (typeof record.errorCode === 'string') this.errorCode = record.errorCode;
    const requestId = typeof record.request_id === 'string' ? record.request_id : headers.get('x-request-id');
    if (requestId) this.requestId = requestId;
    const retryAfterSeconds = parseRetryAfterSeconds(headers.get('retry-after'));
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }

  static async fromResponse(response: Response): Promise<B4mApiError> {
    const text = await response.text().catch(() => '');
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON; keep the text.
    }
    return new B4mApiError(response.status, body, response.headers);
  }
}

/**
 * A polled quest (chat turn, image generation or edit) that did not succeed: it carries `type: "error"`
 * (`reason: 'error'`), ended `stopped` (`'stopped'`), or was still running when the poll's `timeoutMs` ran out
 * (`'timeout'`). `quest` is the last state seen; its `reply` carries the server's explanation.
 */
export class B4mQuestError extends Error {
  readonly reason: 'error' | 'stopped' | 'timeout';
  readonly quest: QuestState;

  constructor(reason: 'error' | 'stopped' | 'timeout', quest: QuestState) {
    super(
      reason === 'timeout'
        ? `quest ${quest.id} still ${quest.status ?? 'pending'} when the poll timed out`
        : (quest.reply ?? `quest ${quest.id} ${reason === 'error' ? 'failed' : 'was stopped'}`)
    );
    this.name = 'B4mQuestError';
    this.reason = reason;
    this.quest = quest;
  }
}

/**
 * Normalize a Retry-After header (RFC 7231: delta-seconds or an HTTP-date) to whole, non-negative seconds;
 * undefined when absent or unparseable.
 */
export function parseRetryAfterSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}
