/**
 * Local stand-in for CloudWatch's `{ $.message = "..." }` evaluation on Lambda-prefixed JSON
 * lines (timestamp, request id, level, then the JSON body). Only the top-level message field
 * counts, which is what the real evaluator does for this selector.
 */
export function matchesMessageFilterPattern(pattern: string, line: string): boolean {
  const selector = /^\{ \$\.message = "([^"]+)" \}$/.exec(pattern);
  if (!selector) throw new Error(`Unsupported metric filter pattern: ${pattern}`);
  const start = line.indexOf('{');
  if (start < 0) return false;
  try {
    const body: unknown = JSON.parse(line.slice(start));
    return typeof body === 'object' && body !== null && (body as { message?: unknown }).message === selector[1];
  } catch {
    return false;
  }
}
