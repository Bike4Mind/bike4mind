import { describe, it, expect, vi } from 'vitest';
import type { IImageGenerationTemplateDocument, IImageTemplateCaller } from '@bike4mind/common';
import { IMAGE_TEMPLATES_PER_USER_MAX } from '@bike4mind/common';
import { assertAuthenticated, assertInteractive } from './access';
import { listTemplates, getTemplate, saveTemplate, updateTemplate, deleteTemplate, recordUse } from './operations';

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
    const listByModel = vi.fn().mockResolvedValue([]);
    const create = vi.fn().mockImplementation(async (d: any) => ({ ...d, id: 'new' }));
    const result = await saveTemplate(caller({ id: 'u1' }), withRepo({ countOwned, listByModel, create }), input);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', usageCount: 0 }));
    expect(result.id).toBe('new');
  });

  it('rejects a same-settings duplicate for the model, regardless of name', async () => {
    const listByModel = vi
      .fn()
      .mockResolvedValue([
        tpl({ id: 'existing', name: 'My Other Name', model: 'flux-pro-1.1', settings: { quality: 'hd' } }),
      ]);
    const create = vi.fn();
    const countOwned = vi.fn().mockResolvedValue(1);
    await expect(saveTemplate(caller(), withRepo({ listByModel, countOwned, create }), input)).rejects.toThrow(
      /already have a template/i
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a same-settings template bound to a DIFFERENT model', async () => {
    // listByModel is model-scoped, so a gpt-image-1 sibling never matches a flux save.
    const listByModel = vi.fn().mockResolvedValue([]);
    const countOwned = vi.fn().mockResolvedValue(0);
    const create = vi.fn().mockImplementation(async (d: any) => ({ ...d, id: 'new' }));
    await expect(saveTemplate(caller(), withRepo({ listByModel, countOwned, create }), input)).resolves.toBeTruthy();
    expect(listByModel).toHaveBeenCalledWith('u1', 'flux-pro-1.1');
  });

  it('rejects author-time when at the per-user cap', async () => {
    const countOwned = vi.fn().mockResolvedValue(IMAGE_TEMPLATES_PER_USER_MAX);
    const listByModel = vi.fn().mockResolvedValue([]);
    const create = vi.fn();
    await expect(saveTemplate(caller(), withRepo({ countOwned, listByModel, create }), input)).rejects.toThrow(
      /limit/i
    );
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

describe('recordUse', () => {
  it('increments usageCount for an owned template', async () => {
    const incrementUsage = vi.fn().mockResolvedValue(tpl({ usageCount: 1 }));
    await recordUse(caller(), withRepo({ incrementUsage }), 't1');
    expect(incrementUsage).toHaveBeenCalledWith('t1', 'u1');
  });

  it('404s when the template is not owned/missing', async () => {
    const incrementUsage = vi.fn().mockResolvedValue(null);
    await expect(recordUse(caller(), withRepo({ incrementUsage }), 't1')).rejects.toThrow(/not found/i);
  });

  it('denies API-key callers', async () => {
    const incrementUsage = vi.fn();
    await expect(recordUse(caller({ isApiKey: true }), withRepo({ incrementUsage }), 't1')).rejects.toThrow();
    expect(incrementUsage).not.toHaveBeenCalled();
  });
});
