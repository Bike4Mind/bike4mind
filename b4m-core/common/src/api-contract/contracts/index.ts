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
