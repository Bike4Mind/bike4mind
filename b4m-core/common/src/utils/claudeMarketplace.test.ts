import { describe, expect, it } from 'vitest';
import { claudeMarketplaceNameFor, claudeSkillNameFor } from './claudeMarketplace';

describe('claudeMarketplaceNameFor', () => {
  it('names the marketplace by the org id tail alone', () => {
    expect(claudeMarketplaceNameFor('65f0aabbccddeeff00112233')).toBe('b4m-org-00112233');
  });
});

describe('claudeSkillNameFor', () => {
  it('falls back to skill when the name has nothing to slug', () => {
    expect(claudeSkillNameFor('Review PR')).toBe('review-pr');
    expect(claudeSkillNameFor('\u30ec\u30d3\u30e5\u30fc')).toBe('skill');
  });
});
