import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import { createPrompt } from './create';
import { getPrompt } from './get';
import { listPromptsByTypes } from './listByTypes';
import { listPromptByName } from './listByName';
import { listPromptByTags } from './listByTags';
import { updatePrompt } from './update';
import { deletePrompt } from './delete';

describe('promptService', () => {
  let mockAdapters: {
    db: {
      prompts: {
        create: Mock;
        findById: Mock;
        findAllByType: Mock;
        findAllByName: Mock;
        findAllWithTags: Mock;
        update: Mock;
        delete: Mock;
      };
    };
  };

  const existing = {
    id: 'prompt-1',
    type: 'system',
    name: 'Greeting',
    promptText: 'Hello',
    tags: ['a'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        prompts: {
          create: vi.fn(),
          findById: vi.fn(),
          findAllByType: vi.fn(),
          findAllByName: vi.fn(),
          findAllWithTags: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
    };
  });

  it('createPrompt persists the validated fields', async () => {
    mockAdapters.db.prompts.create.mockResolvedValue(existing);

    const result = await createPrompt(
      { type: 'system', name: 'Greeting', promptText: 'Hello', tags: ['a'] },
      mockAdapters as any
    );

    expect(mockAdapters.db.prompts.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system', name: 'Greeting', promptText: 'Hello', tags: ['a'] })
    );
    expect(result).toEqual(existing);
  });

  it('getPrompt returns the prompt when found', async () => {
    mockAdapters.db.prompts.findById.mockResolvedValue(existing);

    const result = await getPrompt({ id: 'prompt-1' }, mockAdapters as any);

    expect(result).toEqual(existing);
  });

  it('getPrompt throws NotFoundError when absent', async () => {
    mockAdapters.db.prompts.findById.mockResolvedValue(null);

    await expect(getPrompt({ id: 'missing' }, mockAdapters as any)).rejects.toThrow(NotFoundError);
  });

  it('listPromptsByTypes queries by type', async () => {
    mockAdapters.db.prompts.findAllByType.mockResolvedValue([existing]);

    const result = await listPromptsByTypes({ type: 'system' }, mockAdapters as any);

    expect(mockAdapters.db.prompts.findAllByType).toHaveBeenCalledWith('system');
    expect(result).toEqual([existing]);
  });

  it('listPromptByName queries by name', async () => {
    mockAdapters.db.prompts.findAllByName.mockResolvedValue([existing]);

    await listPromptByName({ name: 'Greeting' }, mockAdapters as any);

    expect(mockAdapters.db.prompts.findAllByName).toHaveBeenCalledWith('Greeting');
  });

  it('listPromptByTags queries with the tag list', async () => {
    mockAdapters.db.prompts.findAllWithTags.mockResolvedValue([existing]);

    await listPromptByTags({ tags: ['a', 'b'] }, mockAdapters as any);

    expect(mockAdapters.db.prompts.findAllWithTags).toHaveBeenCalledWith(['a', 'b']);
  });

  it('updatePrompt applies a partial update without requiring all fields', async () => {
    mockAdapters.db.prompts.update.mockResolvedValue({ ...existing, promptText: 'Hi' });

    const result = await updatePrompt({ id: 'prompt-1', promptText: 'Hi' }, mockAdapters as any);

    // Only the identity + changed field reach the repository - no _id/timestamp leakage.
    expect(mockAdapters.db.prompts.update).toHaveBeenCalledWith({ id: 'prompt-1', promptText: 'Hi' });
    expect(result).toEqual({ ...existing, promptText: 'Hi' });
  });

  it('updatePrompt throws NotFoundError when the prompt is missing or deleted (update resolves null)', async () => {
    mockAdapters.db.prompts.update.mockResolvedValue(null);

    await expect(updatePrompt({ id: 'missing', promptText: 'Hi' }, mockAdapters as any)).rejects.toThrow(NotFoundError);
  });

  it('deletePrompt removes an existing prompt', async () => {
    mockAdapters.db.prompts.findById.mockResolvedValue(existing);
    mockAdapters.db.prompts.delete.mockResolvedValue(undefined);

    await deletePrompt({ id: 'prompt-1' }, mockAdapters as any);

    expect(mockAdapters.db.prompts.delete).toHaveBeenCalledWith('prompt-1');
  });

  it('deletePrompt throws NotFoundError when absent', async () => {
    mockAdapters.db.prompts.findById.mockResolvedValue(null);

    await expect(deletePrompt({ id: 'missing' }, mockAdapters as any)).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.prompts.delete).not.toHaveBeenCalled();
  });
});
