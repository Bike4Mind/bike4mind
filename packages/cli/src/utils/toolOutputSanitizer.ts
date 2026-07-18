/**
 * Post-processing for tool output before it reaches the model.
 *
 * Every tool result - success OR error - is routed through {@link sanitizeToolOutput}
 * at the single choke point in ToolRouter.executeTool. Two guarantees:
 *   1. Known secret shapes (API keys, tokens, credentialed connection strings) are
 *      redacted so a leaky tool or a token-bearing error can't flow into the transcript.
 *   2. Output is capped so an unbounded result can't blow the context budget.
 *
 * The secret patterns mirror the credential rules in `.gitleaks.toml`. This is a
 * SECRET scrubber, deliberately narrow - unlike the PII-focused
 * `sanitizeTelemetryError`, it must not redact ordinary tool content (file paths,
 * source code, IDs) that the model needs to do its job.
 *
 * Scope limit: this matches known secret SHAPES, not entropy. An opaque token with
 * no recognized prefix that isn't on the RHS of a secret-named assignment can slip
 * through. Add a pattern here (and to `.gitleaks.toml`) when a new shape appears.
 */

const REDACTED = '[REDACTED]';

/**
 * Max characters of tool output forwarded to the model (~100 KB, roughly 25k tokens).
 * A backstop against pathological/unbounded output, not a tight per-call budget.
 */
export const MAX_TOOL_OUTPUT_CHARS = 100_000;

/**
 * Secret patterns, applied in order. Specific credential shapes run before the
 * generic KEY=VALUE assignment so a recognized token is redacted as a whole even
 * when it also appears on the right-hand side of an assignment.
 *
 * Each entry either replaces the whole match with a marker, or uses a capture group
 * to preserve non-secret context (e.g. keep the key name, redact only its value).
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Credentialed connection strings (user:pass@host) - the whole URI is sensitive.
  {
    pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?):\/\/[^:@/\s]+:[^@/\s]+@[^\s'"]+/gi,
    replacement: REDACTED,
  },
  // JWTs (header.payload.signature).
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: REDACTED,
  },
  // Anthropic / OpenAI style keys: sk-, sk-ant-, sk-proj-.
  {
    pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
    replacement: REDACTED,
  },
  // Stripe secret/publishable/restricted keys carry a test|live infix; webhook
  // signing secrets (whsec_) do NOT - they are a bare token, so match separately.
  {
    pattern: /\b(?:(?:sk|pk|rk)_(?:test|live)|whsec)_[0-9A-Za-z]{16,}/g,
    replacement: REDACTED,
  },
  // Google / Gemini API keys. A negative lookahead (not a trailing \b) ends the
  // match: a key whose 35th char is `-` would defeat \b, since `-` is already a
  // non-word char and no boundary exists when the next char is also non-word.
  {
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    replacement: REDACTED,
  },
  // AWS access key IDs.
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED,
  },
  // GitHub tokens (PAT, OAuth, server-to-server, refresh, fine-grained).
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    replacement: REDACTED,
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    replacement: REDACTED,
  },
  // Slack tokens.
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacement: REDACTED,
  },
  // Bearer tokens - keep the scheme, redact the credential.
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi,
    replacement: `$1${REDACTED}`,
  },
  // Generic secret-ish assignments (KEY=value / "key": "value") - keep the key,
  // redact the value. Anchored on names that denote a credential.
  //
  // The lookahead exempts a purely-numeric value. `TOKEN` matches LLM-accounting
  // fields this agent reasons over (`totalTokens: 1523`, `promptTokens=900`), and
  // redacting those loses real information. No credential shape we redact is a bare
  // integer, so the exemption costs no coverage.
  {
    pattern:
      /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?)[A-Za-z0-9_]*)(["']?\s*[=:]\s*["']?)(?!\d+(?![^\s"',}]))([^\s"',}]+)/gi,
    replacement: `$1$2${REDACTED}`,
  },
];

/** Replace known secret shapes with a redaction marker. */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/** Truncate to `maxChars`, appending a marker so the model knows output was cut. */
export function enforceOutputCeiling(text: string, maxChars: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[output truncated: ${omitted} of ${text.length} characters omitted, ${maxChars}-character limit]`;
}

/**
 * Redact secrets THEN cap size. Order matters: redacting first ensures a secret
 * straddling the truncation boundary can't survive as a leaked prefix.
 */
export function sanitizeToolOutput(text: string, maxChars: number = MAX_TOOL_OUTPUT_CHARS): string {
  return enforceOutputCeiling(redactSecrets(text), maxChars);
}
