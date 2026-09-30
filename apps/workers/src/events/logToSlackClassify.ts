import { SreClassification } from '@bike4mind/common';

/**
 * Heuristic classification for CloudWatch log errors feeding the SRE Sentinel
 * pipeline. Returns SKIP for transient/infra errors that should not be dispatched
 * (and therefore never auto-file a GitHub issue).
 *
 * Extracted from logToSlack.ts as a dependency-light, pure module so the rules can
 * be unit-tested without loading sst/database/etc.
 */
export function classifyError(message: string): SreClassification {
  // SKIP - request aborts / cancellations (user stop, client disconnect, or
  // request/idle timeouts). These are benign and recoverable, not actionable
  // failures. Backstop so the SRE pipeline never auto-files an abort issue even
  // if some path still logs one at ERROR. The owning backends now
  // log these at WARN, so this is defense-in-depth. `\bAborted\b` catches the bare
  // `new Error('Aborted')` thrown by the shared retry helpers (retry.ts), which the
  // other (phrase-based) alternatives would miss.
  if (
    /\bAbortError\b|\bAborted\b|Request aborted|operation was aborted|no streaming response received|stream timeout - no response received/i.test(
      message
    )
  ) {
    return SreClassification.SKIP;
  }

  // SKIP - transient TLS / socket drops that surface from undici as
  // `TypeError: terminated` (UND_ERR_SOCKET, "other side closed", "socket hang up"):
  // a remote peer closing the connection before the response is fully read. These
  // are recoverable network blips, not code defects, and the shared retry helpers
  // (retry.ts / fetchWithRetry) already classify them as retryable. This MUST run
  // before the `TypeError` -> MEDIUM rule below, which would otherwise mis-file every
  // transient socket drop as a bug.
  //
  // Scoped to the literal undici signatures rather than a bare /terminated/ - the
  // broad word would also swallow genuine incidents ("worker thread terminated",
  // "connection terminated unexpectedly", "process terminated SIGKILL").
  if (/UND_ERR_SOCKET|other side closed|socket hang up|TypeError:\s*terminated/i.test(message)) {
    return SreClassification.SKIP;
  }

  // HIGH - data integrity / validation errors
  if (/ZodError|ValidationError/i.test(message)) {
    return SreClassification.HIGH;
  }

  // MEDIUM - code-level errors
  if (/TypeError|ReferenceError/i.test(message)) {
    return SreClassification.MEDIUM;
  }
  if (/SyntaxError|ImportError/i.test(message)) {
    return SreClassification.MEDIUM;
  }

  // SKIP - transient network errors
  if (/ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return SreClassification.SKIP;
  }
  if (/ThrottlingException|RateLimit/i.test(message)) {
    return SreClassification.SKIP;
  }

  // SKIP - infrastructure errors
  if (/MongoNetworkError/i.test(message)) {
    return SreClassification.SKIP;
  }

  // LOW - anything else with a stack trace
  if (/\n\s+at\s+/m.test(message)) {
    return SreClassification.LOW;
  }

  // No stack trace and no matching pattern - skip
  return SreClassification.SKIP;
}
