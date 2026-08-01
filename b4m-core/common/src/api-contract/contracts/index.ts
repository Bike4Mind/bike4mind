import type { EndpointContract } from '../types';
import { chatContract } from './chat.contract';

/**
 * Every endpoint migrated to the contract abstraction. The OpenAPI generator
 * registers each of these (openapi/registerContract.ts); adding a contract here
 * is all it takes for it to appear in the spec + docs. Hand-registered legacy
 * operations (createCompletion, executeTool) still live in openapi/operations.ts
 * during migration - the two coexist.
 */
export const CONTRACTS: readonly EndpointContract[] = [chatContract];

// A duplicated operationId silently overwrites an SDK method name, and a duplicated
// method+path silently overwrites a whole operation in the spec. Both are cheap to
// make impossible at import time rather than discovering them in generated output.
const seen = new Map<string, string>();
for (const contract of CONTRACTS) {
  for (const key of [`operationId:${contract.operationId}`, `route:${contract.method} ${contract.path}`]) {
    const previous = seen.get(key);
    if (previous) {
      throw new Error(`Duplicate contract ${key} declared by both ${previous} and ${contract.operationId}.`);
    }
    seen.set(key, contract.operationId);
  }
}
