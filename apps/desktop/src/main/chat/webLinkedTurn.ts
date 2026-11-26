import { randomUUID } from 'node:crypto';
import { isAxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import {
  SessionTurnStreamEventSchema,
  visibleReplyText,
  type SessionTurnRequest,
  type SessionTurnStreamEvent,
} from '@bike4mind/common';
import { COMPLETION_HEADER_TIMEOUT_MS, DEFAULT_COMPLETIONS_PATH, STREAM_IDLE_TIMEOUT_MS } from './completions';
import { isConnectionDrop, readErrorBody, readSseResponse, releaseRequestTimeout } from './sseResponse';

/**
 * One turn of a synced Bike4Mind web chat, run by the server in the web session itself
 * (POST /api/v1/turns, PR-side contract in @bike4mind/common schemas/sessionTurns.ts). The server
 * builds the context and bills it exactly as the web composer does; this side only streams it.
 */

export const SESSION_TURNS_PATH = '/api/v1/turns';

/**
 * Where the turns route lives, given where completions do. Both are served by the ChatCompletion
 * service: same-origin on hosted deploys, the advertised service origin on a self-host stack.
 */
export function sessionTurnsEndpoint(completionsEndpoint: string): string {
  if (completionsEndpoint.endsWith(DEFAULT_COMPLETIONS_PATH)) {
    return `${completionsEndpoint.slice(0, -DEFAULT_COMPLETIONS_PATH.length)}${SESSION_TURNS_PATH}`;
  }
  return SESSION_TURNS_PATH;
}

/** The server refused the turn before streaming it: the JSON error's own words and status. */
export class SessionTurnRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errorCode?: string
  ) {
    super(message);
    this.name = 'SessionTurnRequestError';
  }
}

/** A frame the stream cannot use is skipped; one that parses is one of the contract's events. */
export function parseSessionTurnFrame(data: string): SessionTurnStreamEvent | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = SessionTurnStreamEventSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Ask the server to stop one quest of the web session, the way the web composer's Stop does.
 * True only when the server answered for that quest, i.e. it is no longer running: anything else
 * (a network error, another quest, a refusal) leaves the caller to treat it as still running.
 */
export async function stopSessionTurn(axios: AxiosInstance, sessionId: string, questId: string): Promise<boolean> {
  try {
    const response = await axios.post<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/chat/stop-reply`, {
      questId,
    });
    const data = response.data;
    return typeof data === 'object' && data !== null && (data as { questId?: unknown }).questId === questId;
  } catch {
    return false;
  }
}

/**
 * POST the turn and hand each event to `onEvent` until `[DONE]`. Resolves on a clean end or an
 * abort (the server keeps running a turn the client walks away from, as it does on the web;
 * stopSessionTurn is what ends it).
 * Rejects with SessionTurnRequestError on a pre-stream refusal, and with an Error for an `error`
 * frame or a dropped connection. Never retried: a resend would add a second turn.
 */
export async function streamSessionTurn(
  axios: AxiosInstance,
  endpoint: string,
  body: SessionTurnRequest,
  onEvent: (event: SessionTurnStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return;
  let response: AxiosResponse;
  try {
    response = await axios.post(endpoint, body, {
      responseType: 'stream',
      signal,
      timeout: COMPLETION_HEADER_TIMEOUT_MS,
      headers: { 'X-Request-ID': randomUUID() },
    });
  } catch (err) {
    if (signal?.aborted || (isAxiosError(err) && err.code === 'ERR_CANCELED')) return;
    throw await toSessionTurnRequestError(err);
  }
  releaseRequestTimeout(response);
  try {
    await readSseResponse(response, {
      signal,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      onData: data => {
        if (data === '[DONE]') return 'done';
        const event = parseSessionTurnFrame(data);
        if (!event) return;
        if (event.type === 'error') return new Error(event.message || 'The server reported an error mid-reply.');
        onEvent(event);
      },
    });
  } catch (err) {
    if (!isConnectionDrop(err)) throw err;
    if (signal?.aborted) return;
    throw new Error(`The connection to the server dropped before the reply finished (${err.message}).`);
  }
}

async function toSessionTurnRequestError(err: unknown): Promise<Error> {
  if (!isAxiosError(err)) return err instanceof Error ? err : new Error(String(err));
  const status = err.response?.status;
  if (!status) {
    return err.code === 'ECONNREFUSED'
      ? new Error('Cannot reach the Bike4Mind server. Check the environment and your connection.')
      : err;
  }
  const body = await readErrorBody(err);
  const message = body?.message ? `${body.message} (status ${status})` : `The server refused this message (${status}).`;
  return new SessionTurnRequestError(message, status, body?.errorCode);
}

/**
 * The quest's reply slots as the stream rebuilds them, and the text the desktop shows for them:
 * the visible part of every slot, joined, which is what the server stores as the quest's `reply`
 * and so what the next sync reads back (webSessionMapper.ts).
 */
export class LinkedReplySlots {
  private readonly slots: string[] = [];
  private shown = '';

  /** The text to append to what is shown, or null when nothing can be appended. */
  apply(event: { type: 'delta' | 'replace'; slot: number; text: string }): string | null {
    const current = this.slots[event.slot] ?? '';
    this.slots[event.slot] = event.type === 'delta' ? current + event.text : event.text;
    for (let index = 0; index < event.slot; index++) this.slots[index] ??= '';
    const next = this.text;
    // A replaced slot that no longer extends the shown text waits for the final `done`, which
    // carries the whole reply; the live view has only appends.
    if (next.length <= this.shown.length || !next.startsWith(this.shown)) return null;
    const added = next.slice(this.shown.length);
    this.shown = next;
    return added;
  }

  get text(): string {
    return this.slots
      .map(slot => visibleReplyText(slot))
      .join('')
      .trim();
  }
}
