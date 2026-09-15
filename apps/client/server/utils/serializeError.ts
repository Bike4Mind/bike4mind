type SerializedError = {
  message: string;
  name: string;
  stack?: string;
  code?: string;
};

/**
 * Convert an unknown caught value into a shape the Logger can serialize.
 *
 * `Error` properties (`message`, `stack`, `name`) are non-enumerable, so
 * passing a raw `Error` to a JSON-based log pipeline silently drops them
 * and emits `{}` / `[object Object]` in CloudWatch. Use this at every
 * `logger.error(..., { error })` site in webhook/callback handlers.
 */
export function serializeError(err: unknown): SerializedError | string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      message: err.message,
      name: err.name,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  // Non-Error objects (e.g. a thrown plain object or rejected non-Error
  // value) stringify to a useless "[object Object]" via String(). Emit their
  // actual contents as JSON, falling back to the type tag if unserializable
  // (circular refs, BigInt, etc.).
  if (err !== null && typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      const name = (err as { constructor?: { name?: string } }).constructor?.name ?? 'object';
      return `[unserializable ${name}]`;
    }
  }
  return String(err);
}
