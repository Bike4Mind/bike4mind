/**
 * The 400 message for a Mongoose ValidationError raised by a Memento write, or undefined for any
 * other error. A safety net behind CreateMementoSchema for model constraints the schema does not
 * mirror. Name-matched so the routes need no mongoose import.
 */
export function describeMementoValidationError(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'ValidationError') return undefined;
  const paths = Object.keys((error as Error & { errors?: Record<string, unknown> }).errors ?? {});
  return `Invalid memento: ${paths.join(', ') || 'validation failed'}`;
}
