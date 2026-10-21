import { describe, expect, it } from 'vitest';
import { claudeMarketplaceNameFor, claudeSkillNameFor } from './claudeMarketplace';

describe('claudeMarketplaceNameFor', () => {
  it('names the marketplace by the complete org id', () => {
    expect(claudeMarketplaceNameFor('65f0aabbccddeeff00112233')).toBe('b4m-org-65f0aabbccddeeff00112233');
  });
  it('distinguishes organizations with the same id tail', () => {
    expect(claudeMarketplaceNameFor('65a0000000000000000000aa')).not.toBe(
      claudeMarketplaceNameFor('65b0000000000000000000aa')
    );
  });
});

describe('claudeSkillNameFor', () => {
  it('falls back to skill when the name has nothing to slug', () => {
    expect(claudeSkillNameFor('Review PR')).toBe('review-pr');
    expect(claudeSkillNameFor('\u30ec\u30d3\u30e5\u30fc')).toBe('skill');
  });
});
