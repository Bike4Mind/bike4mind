const REDACTED = '[REDACTED]';
const sensitiveSuffix =
  /(?:secret|token|password|apikey|body|bodypreview|prompt|promptpreview|parameterspreview|toolresult|preview|snippet)$/i;
const sensitiveField =
  /^(authorization|proxyAuthorization|cookie|setCookie|headers|config|request|response|body|requestBody|responseBody|data|message|messages|conversation|conversationHistory|prompt|systemPrompt|content|text|toolResult|toolResults|arguments|parameters|parametersPreview|fullChunk|result|response|password|securityQuestions|userNotes|apiKey|xiApiKey|xKey|token|accessToken|refreshToken|clientSecret|signingSecret|secret|previousKey)$/i;

function redactString(value: string): string {
  return value.replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`);
}

/** Sanitize before formatting so JSON, pretty and plain output share the same boundary. */
export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(item => redactLogValue(item, seen));
    if (value instanceof Error) {
      const providerError =
        ('status' in value && typeof value.status === 'number') ||
        ['isAxiosError', 'headers', 'request_id', 'requestID', 'response', 'config', '$metadata', '$response'].some(
          field => field in value
        );
      if (providerError) {
        const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined;
        const status = 'status' in value && typeof value.status === 'number' ? value.status : undefined;
        return { name: 'ProviderError', code, status };
      }
      const fields = redactLogValue({ ...value }, seen) as Record<string, unknown>;
      return {
        ...fields,
        name: value.name,
        message: redactString(value.message),
        stack: redactString(value.stack ?? ''),
      };
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (typeof field === 'function') continue;
      sanitized[key] =
        sensitiveField.test(key.replace(/[-_]/g, '')) || sensitiveSuffix.test(key.replace(/[-_]/g, ''))
          ? REDACTED
          : redactLogValue(field, seen);
    }
    return sanitized;
  } catch {
    return '[Unserializable]';
  } finally {
    seen.delete(value);
  }
}
