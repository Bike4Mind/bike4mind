import { describe, it, expect, vi } from 'vitest';
import type { IImageGenerationTemplateDocument, IImageTemplateCaller } from '@bike4mind/common';
import { IMAGE_TEMPLATES_PER_USER_MAX } from '@bike4mind/common';
import { assertAuthenticated, assertInteractive } from './access';
import { listTemplates, getTemplate, saveTemplate, updateTemplate, deleteTemplate, applyTemplate } from './operations';

const caller = (overrides: Partial<IImageTemplateCaller> = {}): IImageTemplateCaller => ({
  id: 'u1',
  isAdmin: false,
  isApiKey: false,
  ...overrides,
});

const tpl = (overrides: Partial<IImageGenerationTemplateDocument> = {}): IImageGenerationTemplateDocument =>
  ({
    id: 't1',
    userId: 'u1',
    name: 'Cinematic',
    model: 'flux-pro-1.1',
    settings: { quality: 'hd' },
    usageCount: 0,
    ...overrides,
  }) as IImageGenerationTemplateDocument;

/** Build an adapters object whose repo methods are the provided spies. */
const withRepo = (repo: Record<string, unknown>) => ({ db: { templates: repo as any } });

describe('access gates', () => {
  it('assertAuthenticated rejects a missing caller', () => {
    expect(() => assertAuthenticated(undefined)).toThrow();
    expect(() => assertAuthenticated(caller())).not.toThrow();
  });

  it('assertInteractive rejects API-key callers (confused-deputy guard)', () => {
    expect(() => assertInteractive(caller({ isApiKey: true }))).toThrow();
    expect(() => assertInteractive(caller())).not.toThrow();
  });
});

describe('listTemplates', () => {
  it('lists templates owned by the caller', async () => {
    const listOwned = vi.fn().mockResolvedValue([tpl()]);
    const result = await listTemplates(caller({ id: 'u1' }), withRepo({ listOwned }), { limit: 50 });
    expect(listOwned).toHaveBeenCalledWith('u1', 50, 0);
    expect(result).toHaveLength(1);
  });

  it('returns nothing to API-key callers', async () => {
    const listOwned = vi.fn();
    const result = await listTemplates(caller({ isApiKey: true }), withRepo({ listOwned }), { limit: 50 });
    expect(result).toEqual([]);
    expect(listOwned).not.toHaveBeenCalled();
  });
});

describe('getTemplate', () => {
  it('returns an owned template', async () => {
    const findOwned = vi.fn().mockResolvedValue(tpl());
    const result = await getTemplate(caller(), withRepo({ findOwned }), 't1');
    expect(findOwned).toHaveBeenCalledWith('t1', 'u1');
    expect(result.id).toBe('t1');
  });

  it('404s when not owned/missing', async () => {
    const findOwned = vi.fn().mockResolvedValue(null);
    await expect(getTemplate(caller(), withRepo({ findOwned }), 't1')).rejects.toThrow(/not found/i);
  });
});

describe('saveTemplate', () => {
  const input = { name: 'Cinematic', model: 'flux-pro-1.1', settings: { quality: 'hd' as const } };

  it('binds ownership to the caller and defaults usageCount', async () => {
    const countOwned = vi.fn().mockResolvedValue(0);
    const create = vi.fn().mockImplementation(async (d: any) => ({ ...d, id: 'new' }));
    const result = await saveTemplate(caller({ id: 'u1' }), withRepo({ countOwned, create }), input);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', usageCount: 0 }));
    expect(result.id).toBe('new');
  });

  it('rejects author-time when at the per-user cap', async () => {
    const countOwned = vi.fn().mockResolvedValue(IMAGE_TEMPLATES_PER_USER_MAX);
    const create = vi.fn();
    await expect(saveTemplate(caller(), withRepo({ countOwned, create }), input)).rejects.toThrow(/limit/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('denies API-key callers', async () => {
    await expect(saveTemplate(caller({ isApiKey: true }), withRepo({}), input)).rejects.toThrow();
  });
});

describe('updateTemplate / deleteTemplate - ownership', () => {
  it('update 404s when not owned', async () => {
    const updateOwned = vi.fn().mockResolvedValue(null);
    await expect(updateTemplate(caller(), withRepo({ updateOwned }), 't1', { name: 'x' })).rejects.toThrow(
      /not found/i
    );
    expect(updateOwned).toHaveBeenCalledWith('t1', 'u1', { name: 'x' });
  });

  it('delete 404s when not owned', async () => {
    const softDeleteOwned = vi.fn().mockResolvedValue(false);
    await expect(deleteTemplate(caller(), withRepo({ softDeleteOwned }), 't1')).rejects.toThrow(/not found/i);
  });
});

describe('applyTemplate - exact-model + usage', () => {
  it('increments usage and returns the fresh doc when the model matches', async () => {
    const findOwned = vi.fn().mockResolvedValue(tpl({ model: 'flux-pro-1.1' }));
    const incrementUsage = vi.fn().mockResolvedValue(tpl({ usageCount: 1 }));
    const result = await applyTemplate(caller(), withRepo({ findOwned, incrementUsage }), 't1', 'flux-pro-1.1');
    expect(incrementUsage).toHaveBeenCalledWith('t1', 'u1');
    expect(result.usageCount).toBe(1);
  });

  it('rejects a cross-model apply (exact-model backstop) without incrementing', async () => {
    const findOwned = vi.fn().mockResolvedValue(tpl({ model: 'flux-pro-1.1' }));
    const incrementUsage = vi.fn();
    await expect(applyTemplate(caller(), withRepo({ findOwned, incrementUsage }), 't1', 'gpt-image-1')).rejects.toThrow(
      /cannot be applied/i
    );
    expect(incrementUsage).not.toHaveBeenCalled();
  });

  it('applies when no target model is supplied (no backstop to enforce)', async () => {
    const findOwned = vi.fn().mockResolvedValue(tpl());
    const incrementUsage = vi.fn().mockResolvedValue(tpl({ usageCount: 1 }));
    await expect(applyTemplate(caller(), withRepo({ findOwned, incrementUsage }), 't1')).resolves.toBeTruthy();
    expect(incrementUsage).toHaveBeenCalled();
  });

  it('404s when the template is not owned', async () => {
    const findOwned = vi.fn().mockResolvedValue(null);
    await expect(applyTemplate(caller(), withRepo({ findOwned }), 't1', 'flux-pro-1.1')).rejects.toThrow(/not found/i);
  });
});
