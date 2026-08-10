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

// Duplicate-operation detection (operationId / method+path collisions, including
// against the hand-registered ops) runs at spec-generation time via
// assertUniqueOperations in openapi/operations.ts - NOT here at import time, so a
// mistake fails the spec build/tests rather than crashing every module that imports
// the @bike4mind/common barrel.
