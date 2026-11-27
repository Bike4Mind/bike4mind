/**
 * Error name plus server code only. Driver messages can embed parts of the connection string, and
 * the code name is stable across runs, which keeps snapshots deterministic.
 */
export const describeError = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const { codeName, code } = error as { codeName?: unknown; code?: unknown };
  const name = error instanceof Error ? error.name : 'Error';
  const parts = [typeof codeName === 'string' ? codeName : name];
  if (typeof code === 'number' || typeof code === 'string') parts.push(String(code));
  return parts.join(' ');
};
