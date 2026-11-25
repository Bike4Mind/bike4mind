import { devLog } from '../devlog/DevLogSink';
import { ERRORS_TAG } from '../devlog/tags';
import { CHAT_STREAM_TAG } from './devLogTag';

/**
 * Publish one renderer-bound push to the developer log.
 *
 * The downstream half of the chat stream, and a different thing from the upstream SSE frames
 * logged in completions.ts: these are what the UI is actually told, after the agent loop has
 * folded tool calls, reasoning and queue changes into it. Same source, so the same single tag -
 * the direction is a field. Seeing both texts side by side is the point: a delta that differs
 * from the frame it came from is the agent loop having rewritten it.
 *
 * An `error` push is what the conversation shows as a failed turn, so it is also tagged
 * `errors` and kept with the window closed. Its text is in `message`, not `text`.
 *
 * Fields are named one at a time, never spread: a payload carries whatever a session put in it,
 * and an allowlist is the only reason this cannot start carrying something it should not.
 */
export function logDownstream(channel: string, payload: unknown): void {
  const event = (payload ?? {}) as {
    type?: unknown;
    sessionId?: unknown;
    messageId?: unknown;
    text?: unknown;
    message?: unknown;
    status?: unknown;
    stopReason?: unknown;
  };
  const failed = event.type === 'error';
  const publish = failed ? devLog.publishError.bind(devLog) : devLog.publish.bind(devLog);
  publish(() => {
    // The event's own kind, or the channel's name without its namespace.
    const kind = typeof event.type === 'string' ? event.type : (channel.split(':')[1] ?? channel);
    const text =
      typeof event.text === 'string' ? event.text : failed && typeof event.message === 'string' ? event.message : '';
    return {
      tags: failed ? [CHAT_STREAM_TAG, ERRORS_TAG] : [CHAT_STREAM_TAG],
      message: `downstream ${kind}${text ? `: ${text}` : ''}`,
      fields: {
        channel,
        ...(failed ? { source: 'reply' } : {}),
        ...(text ? { chars: text.length } : {}),
        ...(typeof event.sessionId === 'string' ? { session: event.sessionId } : {}),
        ...(failed && typeof event.messageId === 'string' ? { messageId: event.messageId } : {}),
        ...(failed && typeof event.stopReason === 'string' ? { stopReason: event.stopReason } : {}),
        ...(typeof event.status === 'string' ? { status: event.status } : {}),
      },
    };
  });
}
