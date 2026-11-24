import { describe, it, expect } from 'vitest';
import {
  SKILL_TEMPLATE_SLUG_MAX,
  SkillTemplateImageGenerateSchema,
  skillTemplateFreeRunEligibility,
  skillTemplateFreeRunInputKey,
  skillTemplatePagePath,
  skillTemplatePreviewImagePath,
  skillTemplateSlugProblem,
} from './SkillMarketTypes';

describe('skillTemplateFreeRunEligibility', () => {
  it('allows a plain skill', () => {
    expect(skillTemplateFreeRunEligibility({})).toEqual({ eligible: true });
    expect(skillTemplateFreeRunEligibility({ allowedTools: [], claudeCodeAllowedTools: [], files: [] })).toEqual({
      eligible: true,
    });
  });

  it.each([
    ['allowedTools', { allowedTools: ['web_search'] }],
    ['claudeCodeAllowedTools', { claudeCodeAllowedTools: ['Bash(git:*)'] }],
  ])('refuses a skill that declares %s', (_field, snapshot) => {
    expect(skillTemplateFreeRunEligibility(snapshot)).toEqual({
      eligible: false,
      reason: 'This skill uses tools, so it cannot offer a free run.',
    });
  });

  it('refuses a skill with supporting files', () => {
    expect(skillTemplateFreeRunEligibility({ files: [{ path: 'scripts/run.py', content: 'print(1)' }] })).toEqual({
      eligible: false,
      reason: 'This skill needs supporting files, so it cannot offer a free run.',
    });
  });

  it('names tools first when a skill has both', () => {
    const result = skillTemplateFreeRunEligibility({
      allowedTools: ['web_search'],
      files: [{ path: 'references/a.md', content: 'a' }],
    });
    expect(result).toMatchObject({ eligible: false, reason: expect.stringContaining('uses tools') });
  });
});

describe('template paths', () => {
  it('builds the page path', () => {
    expect(skillTemplatePagePath('article-bullets')).toBe('/t/article-bullets');
  });

  it('keys the free-run text per slug', () => {
    expect(skillTemplateFreeRunInputKey('article-bullets')).toBe('b4m.skillTemplate.freeRunInput.article-bullets');
  });

  it('builds the image path with the file id as a cache buster', () => {
    expect(skillTemplatePreviewImagePath('article-bullets', 'file-1')).toBe(
      '/api/skills/template/image/article-bullets?v=file-1'
    );
  });
});

describe('skillTemplateSlugProblem', () => {
  it.each(['summarize', 'a', 'article-bullets-2', 'x'.repeat(SKILL_TEMPLATE_SLUG_MAX)])('accepts %s', slug => {
    expect(skillTemplateSlugProblem(slug)).toBeNull();
  });

  it.each(['', 'Upper', 'under_score', '-lead', 'trail-', 'sp ace', 'x'.repeat(SKILL_TEMPLATE_SLUG_MAX + 1)])(
    'rejects the shape of %j',
    slug => {
      expect(skillTemplateSlugProblem(slug)).toMatch(/lowercase letters, digits and hyphens/);
    }
  );

  it('rejects a reserved word', () => {
    expect(skillTemplateSlugProblem('login')).toBe('That link name is reserved');
  });
});

describe('SkillTemplateImageGenerateSchema', () => {
  it('trims the pasted result and refuses a blank one', () => {
    expect(SkillTemplateImageGenerateSchema.parse({ result: '  done  ' })).toEqual({ result: 'done' });
    expect(SkillTemplateImageGenerateSchema.safeParse({ result: '   ' }).success).toBe(false);
    expect(SkillTemplateImageGenerateSchema.safeParse({ result: 'x', extra: 1 }).success).toBe(false);
  });
});
