import { describe, it, expect, vi } from 'vitest';
import type { ICaller, IBriefcasePromptDocument, IPromptBatchQuery } from '@bike4mind/common';
import { canSeeSystemPrompt, assertCanReadPrompts } from './briefcaseAccess';
import { getPersonalPrompts } from './getPersonalPrompts';
import { getCatalog } from './getCatalog';

const prompt = (overrides: Partial<IBriefcasePromptDocument> = {}): IBriefcasePromptDocument =>
  ({
    id: 'p1',
    type: 'general',
    name: 'Prompt',
    promptText: 'hello',
    userId: null,
    ...overrides,
  }) as IBriefcasePromptDocument;

const caller = (overrides: Partial<ICaller> = {}): ICaller => ({
  id: 'u1',
  entitlements: [],
  isAdmin: false,
  isApiKey: false,
  ...overrides,
});

describe('canSeeSystemPrompt — visibility scoping', () => {
  it('shows unscoped prompts to everyone', () => {
    expect(canSeeSystemPrompt(prompt({ visibilityScopes: null }), caller())).toBe(true);
    expect(canSeeSystemPrompt(prompt({ visibilityScopes: [] }), caller())).toBe(true);
  });

  it('hides scoped prompts from users lacking the entitlement', () => {
    expect(canSeeSystemPrompt(prompt({ visibilityScopes: ['vip'] }), caller({ entitlements: [] }))).toBe(false);
  });

  it('shows scoped prompts to users holding a matching entitlement (case-insensitive)', () => {
    expect(canSeeSystemPrompt(prompt({ visibilityScopes: ['VIP'] }), caller({ entitlements: ['vip'] }))).toBe(true);
  });

  it('lets an interactive admin bypass scoping', () => {
    expect(canSeeSystemPrompt(prompt({ visibilityScopes: ['vip'] }), caller({ isAdmin: true }))).toBe(true);
  });

  it('does NOT let an API-key admin bypass scoping', () => {
    expect(canSeeSystemPrompt(prompt({ visibilityScopes: ['vip'] }), caller({ isAdmin: true, isApiKey: true }))).toBe(
      false
    );
  });
});

describe('assertCanReadPrompts — read gate', () => {
  it('rejects an unauthenticated caller', () => {
    expect(() => assertCanReadPrompts(undefined)).toThrow();
  });
  it('allows an authenticated caller', () => {
    expect(() => assertCanReadPrompts(caller())).not.toThrow();
  });
});

describe('getPersonalPrompts — caller scoping', () => {
  it('returns the caller’s own personal prompts', async () => {
    const listPersonal = vi.fn().mockResolvedValue([prompt({ id: 'mine', userId: 'u1' })]);
    const result = await getPersonalPrompts(caller({ id: 'u1' }), {
      db: { briefcasePrompts: { listPersonal } as any },
    });
    expect(listPersonal).toHaveBeenCalledWith('u1');
    expect(result).toHaveLength(1);
  });

  it('returns nothing to API-key callers (confused-deputy guard)', async () => {
    const listPersonal = vi.fn();
    const result = await getPersonalPrompts(caller({ isApiKey: true }), {
      db: { briefcasePrompts: { listPersonal } as any },
    });
    expect(listPersonal).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('getCatalog — batch resolution', () => {
  const adapters = (over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) => ({
    db: {
      briefcasePrompts: {
        listPersonal: over.listPersonal ?? vi.fn().mockResolvedValue([prompt({ id: 'mine', userId: 'u1' })]),
        listSystemByType: over.listSystemByType ?? vi.fn().mockResolvedValue([prompt({ id: 'sys', type: 'news' })]),
        listSystemByTags: over.listSystemByTags ?? vi.fn().mockResolvedValue([]),
        findByIdForCaller: vi.fn(),
      } as any,
    },
  });

  it('resolves personal, type, and tag queries into a key-keyed map', async () => {
    const queries: IPromptBatchQuery[] = [
      { key: 'mine', personal: true },
      { key: 'news', type: 'news' },
    ];
    const result = await getCatalog(queries, caller({ id: 'u1' }), adapters());
    expect(Object.keys(result).sort()).toEqual(['mine', 'news']);
    expect(result.mine[0].id).toBe('mine');
    expect(result.news[0].id).toBe('sys');
  });

  it('does not coerce personal prompts for an API-key caller', async () => {
    const listPersonal = vi.fn();
    const result = await getCatalog(
      [{ key: 'mine', personal: true }],
      caller({ id: 'u1', isApiKey: true }),
      adapters({ listPersonal })
    );
    expect(result.mine).toEqual([]);
    expect(listPersonal).not.toHaveBeenCalled();
  });

  it('is all-or-nothing: one failing sub-query rejects the whole call', async () => {
    const failing = adapters({
      listSystemByType: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(
      getCatalog(
        [
          { key: 'ok', personal: true },
          { key: 'bad', type: 'news' },
        ],
        caller({ id: 'u1' }),
        failing
      )
    ).rejects.toThrow('boom');
  });

  it('filters entitlement-scoped system prompts out of the result', async () => {
    const a = adapters({
      listSystemByType: vi
        .fn()
        .mockResolvedValue([
          prompt({ id: 'open', visibilityScopes: [] }),
          prompt({ id: 'gated', visibilityScopes: ['vip'] }),
        ]),
    });
    const result = await getCatalog([{ key: 'news', type: 'news' }], caller({ entitlements: [] }), a);
    expect(result.news.map(p => p.id)).toEqual(['open']);
  });
});
