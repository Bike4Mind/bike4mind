/** Whether an API Gateway PostToConnection failed because the connection is gone (closed or expired). */
export function isGoneError(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.name === 'GoneException' || e?.$metadata?.httpStatusCode === 410;
}
