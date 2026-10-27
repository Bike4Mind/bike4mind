const MAX_CAUSES = 5;

function describeNonError(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[Unserializable]';
  }
}

/**
 * One-line rendering of an error's `cause` chain ("ECONNRESET: read ECONNRESET"), or undefined when
 * it has none. For log fields that alert sinks print as `${value}`, where a nested object would
 * show as `[object Object]`.
 */
export function describeErrorCause(err: unknown): string | undefined {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  while (current !== undefined && parts.length < MAX_CAUSES && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const { code } = current as Error & { code?: unknown };
      parts.push(typeof code === 'string' ? `${code}: ${current.message}` : `${current.name}: ${current.message}`);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(describeNonError(current));
      break;
    }
  }
  return parts.length > 0 ? parts.join(' <- ') : undefined;
}
