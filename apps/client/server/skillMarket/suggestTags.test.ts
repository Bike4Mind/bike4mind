import { describe, it, expect, vi } from 'vitest';

vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn() },
  getEffectiveApiKeyByBackend: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ SkillListing: {} }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));

import { normalizeSuggestedTags, suggestListingTags } from './suggestTags';
import type { ClassifierLlm } from './classifySkill';

const snapshot = { name: 'fmt', description: 'Formats text', body: 'Rewrite the text as bullets.' };
const llmReturning = (raw: string): ClassifierLlm => ({ model: 'm', complete: vi.fn(async () => raw) });

describe('normalizeSuggestedTags', () => {
  it.each([
    ['not an array', 'writing', []],
    ['non-strings', ['writing', 3, null, { a: 1 }], ['writing']],
    ['more than 5', ['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'd', 'e']],
    ['invalid chars', ['ok', 'c++', 'naive!', '-lead'], ['ok']],
    [
      'hash, spaces, underscores, case',
      ['#Writing', ' Code Review ', 'snake_case'],
      ['writing', 'code-review', 'snake-case'],
    ],
    ['duplicates after normalizing', ['SQL', '#sql', 'sql'], ['sql']],
    ['over 24 chars clipped', ['a'.repeat(30)], ['a'.repeat(24)]],
  ])('%s', (_label, input, expected) => {
    expect(normalizeSuggestedTags(input)).toEqual(expected);
  });
});

describe('suggestListingTags', () => {
  it('parses a JSON object', async () => {
    expect(await suggestListingTags(snapshot, llmReturning('{"tags":["writing","formatting"]}'))).toEqual([
      'writing',
      'formatting',
    ]);
  });

  it('parses fenced JSON with prose around it', async () => {
    const raw = 'Here you go:\n```json\n{"tags": ["Writing"]}\n```\nEnjoy';
    expect(await suggestListingTags(snapshot, llmReturning(raw))).toEqual(['writing']);
  });

  it.each(['no json at all', '{"tags": "writing"}', '["writing"]', '{"tags": [}'])(
    'returns [] for junk %s',
    async raw => {
      expect(await suggestListingTags(snapshot, llmReturning(raw))).toEqual([]);
    }
  );

  it('returns [] when the model throws', async () => {
    const llm: ClassifierLlm = { model: 'm', complete: vi.fn(async () => Promise.reject(new Error('boom'))) };
    expect(await suggestListingTags(snapshot, llm)).toEqual([]);
  });

  it('shows the model the declared Claude Code tools', async () => {
    const llm = llmReturning('{"tags":[]}');
    await suggestListingTags({ ...snapshot, claudeCodeAllowedTools: ['Bash(gh:*)'] }, llm);
    expect(vi.mocked(llm.complete).mock.calls[0][1]).toContain('declared Claude Code tools: Bash(gh:*)');
  });

  it('wraps the skill in nonce markers', async () => {
    const llm = llmReturning('{"tags":[]}');
    await suggestListingTags(snapshot, llm);
    const user = vi.mocked(llm.complete).mock.calls[0][1];
    const nonce = user.match(/=====BEGIN SKILL DATA ([0-9a-f]+)=====/)?.[1];
    expect(nonce).toBeTruthy();
    expect(user).toContain(`=====END SKILL DATA ${nonce}=====`);
    expect(user.indexOf(snapshot.body)).toBeGreaterThan(user.indexOf('BEGIN SKILL DATA'));
    expect(user.indexOf(snapshot.body)).toBeLessThan(user.indexOf('END SKILL DATA'));
  });
});
