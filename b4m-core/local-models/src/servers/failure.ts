import { PullIdleTimeoutError } from '../errors';
import { ServerRedirectError, ServerTransportError } from './serverFetch';

/** The system error code on the error itself (Node http mid-body drops) or on its cause (fetch). */
export function errorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const own = (err as { code?: unknown }).code;
  if (typeof own === 'string') return own;
  const cause = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof cause === 'string' ? cause : undefined;
}

export const DROP_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE']);

/** One line for a failed request; never includes a header or credential. */
export function describeFailure(err: unknown): string {
  if (err instanceof ServerTransportError || err instanceof ServerRedirectError) return err.message;
  if (err instanceof DOMException && err.name === 'TimeoutError') return 'it did not answer in time';
  if (err instanceof Error && err.name === 'TimeoutError') return 'it did not answer in time';
  if (err instanceof PullIdleTimeoutError) return 'it stopped sending data';
  const code = errorCode(err);
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'no route to the host';
  if (code === 'ETIMEDOUT') return 'the connection timed out';
  if (code && DROP_CODES.has(code)) return 'the connection dropped';
  if (err instanceof TypeError && /terminated|aborted/i.test(err.message)) return 'the connection dropped';
  if (err instanceof Error && /ended (the reply )?before/i.test(err.message)) return 'the connection dropped';
  return code ?? (err instanceof Error ? err.message : String(err));
}
