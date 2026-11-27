/**
 * Cross-cutting tag for failures. It rides alongside a record's source tag ('chat-stream',
 * 'renderer'), never instead of it, so one filter shows every error whatever produced it.
 * Publish through DevLogSink.publishError, which adds it if a draft omits it.
 */
export const ERRORS_TAG = 'errors';
