import type { EndpointContract } from '../types';
import { chatContract } from './chat.contract';
import { executeToolContract } from './tools.contract';
import { createCompletionContract } from './completions.contract';

/**
 * Every public endpoint, as a contract. The OpenAPI generator registers each of
 * these (openapi/registerContract.ts); adding a contract here is all it takes for
 * it to appear in the spec + docs. This is the single source of truth for the
 * published API surface - the entire `/v1` docs are generated from this array.
 */
export const CONTRACTS: readonly EndpointContract[] = [chatContract, executeToolContract, createCompletionContract];
