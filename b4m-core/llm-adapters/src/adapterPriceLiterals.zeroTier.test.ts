import type { ModelInfo } from '@bike4mind/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

const textModel = (id: string, pricing: Record<number, { input: number; output: number }>) =>
  ({ id, type: 'text', pricing }) as unknown as ModelInfo;

describe('adapterPriceLadders with a zero-rate tier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('leaves out a model whose upper tier would bill nothing, and keeps a fully priced one', async () => {
    vi.resetModules();
    // Imported after the reset: the module under test re-imports the backend, so a spy on an earlier copy would never apply.
    const { OpenAIBackend } = await import('./openaiBackend');
    vi.spyOn(OpenAIBackend.prototype, 'getModelInfo').mockResolvedValue([
      textModel('upper-zero', { 0: { input: 1e-6, output: 2e-6 }, 200000: { input: 0, output: 0 } }),
      textModel('upper-zero-output', { 0: { input: 1e-6, output: 2e-6 }, 200000: { input: 2e-6, output: 0 } }),
      textModel('fully-priced', { 0: { input: 1e-6, output: 2e-6 }, 200000: { input: 2e-6, output: 4e-6 } }),
    ]);
    const { adapterPriceLadders, adapterPriceTiers } = await import('./adapterPriceLiterals');

    const ladders = await adapterPriceLadders();
    const tiers = await adapterPriceTiers();

    expect(ladders.has('upper-zero')).toBe(false);
    expect(ladders.has('upper-zero-output')).toBe(false);
    expect(ladders.has('fully-priced')).toBe(true);
    expect(tiers.has('upper-zero')).toBe(false);
    expect(tiers.get('fully-priced')).toEqual({ input: 1e-6, output: 2e-6 });
  });
});
