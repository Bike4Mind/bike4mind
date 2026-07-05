import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { createDeepAgentToolMaterializer } from './toolMaterializer';

// A minimal backend stand-in; never invoked by the paths under test.
const fakeLlm = { complete: vi.fn() } as unknown as ICompletionBackend;

describe('createDeepAgentToolMaterializer', () => {
  it('short-circuits to no tools for an empty profile (no DB / storage access)', async () => {
    const materialize = createDeepAgentToolMaterializer({
      llm: fakeLlm,
      model: 'fake-model',
      logger: new Logger(),
    });
    // Empty enabledToolNames must return [] before touching the owner user,
    // api-key table, storage, or buildSharedTools.
    await expect(materialize([], 'owner-1')).resolves.toEqual([]);
  });
});
