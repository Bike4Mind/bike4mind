import { describe, it, expect, vi } from 'vitest';

// perfLogger is a side-effect-free console wrapper but importing it via the
// `@client/app/utils/performanceLogger` alias drags the full Vite dev-only
// path into the test runtime. Stub it explicitly.
vi.mock('@client/app/utils/performanceLogger', () => ({
  default: { log: vi.fn() },
}));

import { findAgentsByMentions } from './useAgentMentions';

// `detectAgentMentions` behavior is tested in `@bike4mind/common`
// (`b4m-core/common/src/__tests__/agentMentions.test.ts`); this file
// covers the client-only `findAgentsByMentions` helper.

describe('findAgentsByMentions', () => {
  const agents = [
    { id: '1', name: 'Research Lead', triggerWords: ['@research-lead', '@researcher'] },
    { id: '2', name: 'Brand Voice Writer', triggerWords: ['@writer'] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any[];

  it('matches by trigger word with hyphens', () => {
    expect(findAgentsByMentions(['research-lead'], agents).map(a => a.id)).toEqual(['1']);
  });

  it('matches by an additional alias on the same agent', () => {
    expect(findAgentsByMentions(['researcher'], agents).map(a => a.id)).toEqual(['1']);
  });

  it('returns [] when nothing matches', () => {
    expect(findAgentsByMentions(['unknown'], agents)).toEqual([]);
  });

  it('returns [] when mentions is empty', () => {
    expect(findAgentsByMentions([], agents)).toEqual([]);
  });
});
