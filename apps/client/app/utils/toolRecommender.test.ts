import { describe, it, expect } from 'vitest';
import { recommendTools, mergeTools } from './toolRecommender';

describe('recommendTools — image_generation', () => {
  const recommends = (prompt: string) => recommendTools(prompt).some(r => r.tool === 'image_generation');

  it('matches "[verb] a <subject> image" word order (regression for #smart-mode-image-gen)', () => {
    expect(recommends('generate a cat image')).toBe(true);
    expect(recommends('draw a cute cat picture')).toBe(true);
    expect(recommends('create a beautiful sunset photo')).toBe(true);
    expect(recommends('paint a watercolor painting')).toBe(true);
  });

  it('still matches the zero-subject and "<noun> of" phrasings', () => {
    expect(recommends('generate an image')).toBe(true);
    expect(recommends('make me a portrait')).toBe(true);
    expect(recommends('generate an image of a cat')).toBe(true);
    expect(recommends('a picture of the eiffel tower')).toBe(true);
  });

  it('does not fire for unrelated prompts', () => {
    expect(recommends('what is the weather today')).toBe(false);
    expect(recommends('summarize this document for me')).toBe(false);
  });
});

describe('recommendTools - decide', () => {
  const recommends = (prompt: string) => recommendTools(prompt).some(r => r.tool === 'decide');

  it('fires on an explicit ask', () => {
    expect(recommends('use the decide tool for this ticket')).toBe(true);
    expect(recommends('classify this feedback with a probability for each label')).toBe(true);
    expect(recommends('score this from 1 to 5')).toBe(true);
    expect(recommends('make a decision with probabilities for each option')).toBe(true);
  });

  it('does not fire on a generic question, which is a conversation rather than a decision call', () => {
    expect(recommends('should I reply to this customer?')).toBe(false);
    expect(recommends('what is the weather today')).toBe(false);
    expect(recommends('help me decide between these two options')).toBe(false);
  });
});

describe('mergeTools', () => {
  it('unions recommendations with manually pinned tools and dedupes', () => {
    const merged = mergeTools([{ tool: 'image_generation', reason: 'Image Gen' }], ['web_search']);
    expect(merged).toContain('image_generation');
    expect(merged).toContain('web_search');
  });

  it('does not duplicate a tool present in both lists', () => {
    const merged = mergeTools([{ tool: 'web_search', reason: 'Web Search' }], ['web_search']);
    expect(merged.filter(t => t === 'web_search')).toHaveLength(1);
  });
});
