import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('openai', () => {
  const OpenAI = vi.fn(function (this: { chat: { completions: { create: (...a: unknown[]) => unknown } } }) {
    this.chat = { completions: { create: (...a: unknown[]) => createMock(...a) } };
  });
  return { default: OpenAI };
});

import { runTaxonomyInference, emptyTaxonomyResponse } from './runTaxonomyInference';

const completionWith = (content: string | null) => ({
  choices: [{ message: { content } }],
});

describe('runTaxonomyInference', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('propagates a genuine API-call failure rather than swallowing it', async () => {
    const apiError = new Error('401 Incorrect API key provided');
    createMock.mockRejectedValue(apiError);

    await expect(runTaxonomyInference('bad-key', [])).rejects.toThrow(apiError);
  });

  it('returns an empty result (does not throw) for unparseable JSON content', async () => {
    createMock.mockResolvedValue(completionWith('not valid json{'));

    const result = await runTaxonomyInference('key', [], { existingPrefix: 'acme:' });

    expect(result).toEqual(emptyTaxonomyResponse('acme:'));
  });

  it('returns an empty result for a response missing categories', async () => {
    createMock.mockResolvedValue(completionWith(JSON.stringify({ suggestedPrefix: 'acme:' })));

    const result = await runTaxonomyInference('key', [], { existingPrefix: 'acme:' });

    expect(result).toEqual(emptyTaxonomyResponse('acme:'));
  });

  it('returns an empty result when categories is not an array', async () => {
    createMock.mockResolvedValue(completionWith(JSON.stringify({ suggestedPrefix: 'acme:', categories: 'nope' })));

    const result = await runTaxonomyInference('key', [], { existingPrefix: 'acme:' });

    expect(result).toEqual(emptyTaxonomyResponse('acme:'));
  });

  it('returns an empty result for blank content', async () => {
    createMock.mockResolvedValue(completionWith(null));

    const result = await runTaxonomyInference('key', [], { existingPrefix: 'acme:' });

    expect(result).toEqual(emptyTaxonomyResponse('acme:'));
  });

  it('returns an empty result (does not throw) when the response has no choices array at all', async () => {
    createMock.mockResolvedValue({ choices: undefined });

    const result = await runTaxonomyInference('key', [], { existingPrefix: 'acme:' });

    expect(result).toEqual(emptyTaxonomyResponse('acme:'));
  });

  it('does not wipe a valid result when suggestedPrefix is off-schema (non-string) - defaults it instead', async () => {
    const categories = [{ tagName: 'acme:type:contract', description: '', confidence: 0.9, matchingFolders: [] }];
    createMock.mockResolvedValue(
      completionWith(JSON.stringify({ suggestedPrefix: 123, categories, fileAssignments: [] }))
    );

    const result = await runTaxonomyInference('key', [], { existingPrefix: 'acme:' });

    expect(result.categories).toEqual(categories);
    expect(result.suggestedPrefix).toBe('acme:');
  });

  it('does not wipe a valid result just because suggestedPrefix is missing - defaults it instead', async () => {
    const categories = [{ tagName: 'acme:type:contract', description: '', confidence: 0.9, matchingFolders: [] }];
    createMock.mockResolvedValue(completionWith(JSON.stringify({ categories, fileAssignments: [] })));

    const result = await runTaxonomyInference('key', [], { existingPrefix: 'acme:' });

    expect(result.categories).toEqual(categories);
    expect(result.suggestedPrefix).toBe('acme:');
  });

  it('returns a fully valid response as-is, with the prefix colon-normalized', async () => {
    const categories = [{ tagName: 'acme:type:contract', description: '', confidence: 0.9, matchingFolders: [] }];
    const fileAssignments = [{ relativePath: 'a.pdf', suggestedTags: [{ name: 'acme:type:contract', strength: 0.9 }] }];
    createMock.mockResolvedValue(
      completionWith(JSON.stringify({ suggestedPrefix: 'acme', suggestedName: 'Acme', categories, fileAssignments }))
    );

    const result = await runTaxonomyInference('key', []);

    expect(result.suggestedPrefix).toBe('acme:');
    expect(result.categories).toEqual(categories);
    expect(result.fileAssignments).toEqual(fileAssignments);
  });

  it('never calls the provider when the reservation is refused', async () => {
    const reserve = vi.fn().mockRejectedValue(new Error('insufficient credits'));

    await expect(runTaxonomyInference('key', [], { reserve })).rejects.toThrow('insufficient credits');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('settles the reported usage after a call and refunds a failed one', async () => {
    const settle = vi.fn().mockResolvedValue(1);
    const refund = vi.fn();
    const reserve = vi.fn().mockResolvedValue({ settle, refund });
    createMock.mockResolvedValue({ ...completionWith(null), usage: { prompt_tokens: 120, completion_tokens: 30 } });

    await runTaxonomyInference('key', [], { reserve });
    expect(reserve).toHaveBeenCalledWith(expect.any(Array), 4000);
    expect(settle).toHaveBeenCalledWith({ inputTokens: 120, outputTokens: 30 });

    createMock.mockRejectedValue(new Error('500'));
    await expect(runTaxonomyInference('key', [], { reserve })).rejects.toThrow('500');
    expect(refund).toHaveBeenCalledOnce();
  });
});
