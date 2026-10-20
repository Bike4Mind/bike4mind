import { describe, expect, it } from 'vitest';
import { claudeMarketplaceNameFor, claudePluginNameFor, claudeSkillNameFor } from './claudeMarketplace';

describe('claudeMarketplaceNameFor', () => {
  it('slugs the org name behind a b4m- prefix', () => {
    expect(claudeMarketplaceNameFor({ id: '65f0aa', name: '  Acme Labs, Inc.' })).toBe('b4m-acme-labs-inc');
  });

  it('falls back to the org id when the name has nothing to slug', () => {
    expect(claudeMarketplaceNameFor({ id: '65f0aabbccddeeff00112233', name: '***' })).toBe('b4m-org-00112233');
  });

  it('caps the slug at 40 characters without a trailing hyphen', () => {
    const name = claudeMarketplaceNameFor({ id: 'x', name: `${'a'.repeat(39)} b` });
    expect(name).toBe(`b4m-${'a'.repeat(39)}`);
  });
});

describe('claudePluginNameFor', () => {
  it('suffixes the id tail on a collision', () => {
    const taken = new Set<string>();
    expect(claudePluginNameFor('review-pr', 'aaaaaa111111', taken)).toBe('review-pr');
    expect(claudePluginNameFor('review-pr', 'bbbbbb222222', taken)).toBe('review-pr-222222');
  });
});

describe('claudeSkillNameFor', () => {
  it('falls back to skill when the name has nothing to slug', () => {
    expect(claudeSkillNameFor('Review PR')).toBe('review-pr');
    expect(claudeSkillNameFor('\u30ec\u30d3\u30e5\u30fc')).toBe('skill');
  });
});
