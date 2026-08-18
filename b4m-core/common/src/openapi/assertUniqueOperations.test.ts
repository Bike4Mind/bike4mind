import { describe, it, expect } from 'vitest';
import { assertUniqueOperations } from './assertUniqueOperations';

describe('assertUniqueOperations', () => {
  it('accepts a set of distinct operations', () => {
    expect(() =>
      assertUniqueOperations([
        { operationId: 'sendChatMessage', method: 'post', path: '/api/chat' },
        { operationId: 'createCompletion', method: 'post', path: '/api/ai/v1/completions' },
        { operationId: 'executeTool', method: 'post', path: '/api/ai/v1/tools' },
      ])
    ).not.toThrow();
  });

  it('throws on a duplicate operationId (SDK method-name collision)', () => {
    expect(() =>
      assertUniqueOperations([
        { operationId: 'executeTool', method: 'post', path: '/api/a' },
        { operationId: 'executeTool', method: 'post', path: '/api/b' },
      ])
    ).toThrow(/Duplicate operationId "executeTool"/);
  });

  it('throws on a duplicate method+path (operation-overwrite collision)', () => {
    expect(() =>
      assertUniqueOperations([
        { operationId: 'a', method: 'post', path: '/api/ai/v1/tools' },
        { operationId: 'b', method: 'POST', path: '/api/ai/v1/tools' }, // case-insensitive method
      ])
    ).toThrow(/Duplicate route "POST \/api\/ai\/v1\/tools"/);
  });

  it('catches a contract-vs-hand-registered collision (P3-11), not just contract-vs-contract', () => {
    // The combined list is what operations.ts passes; a contract reusing a hand-
    // registered operationId must be rejected.
    expect(() =>
      assertUniqueOperations([
        { operationId: 'createCompletion', method: 'post', path: '/api/chat' }, // contract
        { operationId: 'createCompletion', method: 'post', path: '/api/ai/v1/completions' }, // hand-registered
      ])
    ).toThrow(/Duplicate operationId "createCompletion"/);
  });

  it('catches a duplicate even when the operationId is the empty string (no truthiness gap)', () => {
    // The old `if (previous)` guard missed this: seen.get returns '' (falsy).
    expect(() =>
      assertUniqueOperations([
        { operationId: '', method: 'get', path: '/api/a' },
        { operationId: '', method: 'get', path: '/api/b' },
      ])
    ).toThrow(/Duplicate operationId/);
  });
});
