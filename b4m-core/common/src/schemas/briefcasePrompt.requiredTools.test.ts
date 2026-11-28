import { describe, expect, it } from 'vitest';
import { BriefcaseRequiredToolsSchema } from './briefcasePrompt';

describe('BriefcaseRequiredToolsSchema', () => {
  it('accepts built-in and overlay-supplied names and an empty list', () => {
    expect(BriefcaseRequiredToolsSchema.parse(['web_search', 'overlay_tool_a'])).toEqual([
      'web_search',
      'overlay_tool_a',
    ]);
    expect(BriefcaseRequiredToolsSchema.parse([])).toEqual([]);
  });

  it('still rejects the disallowed set and non-identifier values', () => {
    expect(BriefcaseRequiredToolsSchema.safeParse(['blog_publish']).success).toBe(false);
    expect(BriefcaseRequiredToolsSchema.safeParse(['Not A Tool']).success).toBe(false);
    expect(BriefcaseRequiredToolsSchema.safeParse(['']).success).toBe(false);
  });
});
