import { describe, it, expect } from 'vitest';
import type { ISkillListingTemplate } from '@bike4mind/common';
import { formFromDraft, formFromTemplate, formIsDirty, formToUpdate, inputsProblem, slugProblem } from './templateForm';

const saved = {
  slug: 'summarize',
  headline: 'Three bullets',
  inputs: [{ label: 'Article', required: true }],
  examplePrompt: 'Summarize this',
} as ISkillListingTemplate;

describe('templateForm', () => {
  it('is dirty before the first save and after an edit, not for whitespace alone', () => {
    const form = formFromTemplate(saved);
    expect(formIsDirty(form, null)).toBe(true);
    expect(formIsDirty(form, saved)).toBe(false);
    expect(formIsDirty({ ...form, headline: ' Three bullets ' }, saved)).toBe(false);
    expect(formIsDirty({ ...form, inputs: [{ label: 'Article', required: false }] }, saved)).toBe(true);
    expect(formIsDirty({ ...form, confirmVersionId: 'v2' }, saved)).toBe(true);
  });

  it('sends the slug only while it may change and the version only when confirmed', () => {
    const drafted = formFromDraft(' summarize ', saved, 'v1');
    expect(formToUpdate(drafted, false)).toEqual({
      slug: 'summarize',
      headline: 'Three bullets',
      inputs: [{ label: 'Article', required: true }],
      examplePrompt: 'Summarize this',
      generatedFromVersionId: 'v1',
    });
    const update = formToUpdate(formFromTemplate(saved), true);
    expect(update).not.toHaveProperty('slug');
    expect(update).not.toHaveProperty('generatedFromVersionId');
  });

  it('keeps at most the allowed number of drafted inputs', () => {
    const inputs = ['a', 'b', 'c', 'd'].map(label => ({ label, required: false }));
    expect(formFromDraft('s', { ...saved, inputs }, null).inputs).toHaveLength(3);
  });

  it('checks the slug unless it is frozen, and every input label', () => {
    const form = { ...formFromTemplate(saved), slug: 'Bad' };
    expect(slugProblem(form, false)).toMatch(/lowercase/);
    expect(slugProblem(form, true)).toBeNull();
    expect(inputsProblem({ ...form, inputs: [{ label: ' ', required: true }] })).toMatch(/label/);
    expect(inputsProblem(form)).toBeNull();
  });
});
