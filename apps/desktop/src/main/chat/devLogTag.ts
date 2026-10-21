/**
 * The chat completion stream's one developer-log tag.
 *
 * One tag per SOURCE, not per event: the dev window's filter is "which part of the app am I
 * watching", so a source contributes exactly one toggle however many kinds of line it emits.
 * Everything that varies within a source - the direction, the event kind, the conversation -
 * is a field on the line, not another tag.
 *
 * A second source brings its own constant and nothing else.
 */
export const CHAT_STREAM_TAG = 'chat-stream';
