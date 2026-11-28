import type { TestError } from '@playwright/test/reporter';
import { omitAuthToken } from './auth-seed';

/** Scrub reported error text, including a serialized Error.cause chain. */
export function redactAuthError(error: TestError): void {
  const visited = new Set<TestError>();
  for (let current: TestError | undefined = error; current && !visited.has(current); current = current.cause) {
    visited.add(current);
    if (current.message) current.message = omitAuthToken(current.message);
    if (current.stack) current.stack = omitAuthToken(current.stack);
    if (current.value) current.value = omitAuthToken(current.value);
  }
}
