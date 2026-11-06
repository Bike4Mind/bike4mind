import { describe, it, expect, vi } from 'vitest';
import { IUserDocument, NotFoundError } from '@bike4mind/common';
import { toggleSystemPrompt } from './toggleSystemPrompt';
import { createShareableFake } from '../__tests__/utils/shareableFake';

const OWNER = { id: 'user-owner' } as IUserDocument;

const setup = (enabled = true) => {
  const project = {
    id: 'project-1',
    userId: OWNER.id,
    systemPrompts: [{ fileId: 'file-1', enabled }],
    users: [],
    groups: [],
  };
  const projectUpdate = vi.fn().mockResolvedValue({});
  const adapters = {
    db: { projects: { shareable: createShareableFake([project as never]), updateWithUpdateAccess: projectUpdate } },
  };

  const run = (params: { fileId: string; enabled?: boolean }) =>
    toggleSystemPrompt(OWNER, { projectId: 'project-1', ...params }, adapters as any);
  return { projectUpdate, run };
};

describe('toggleSystemPrompt', () => {
  it('flips the prompt when no state is given', async () => {
    const { projectUpdate, run } = setup(true);

    const project = await run({ fileId: 'file-1' });

    expect(project.systemPrompts[0].enabled).toBe(false);
    expect(projectUpdate).toHaveBeenCalledTimes(1);
  });

  it('sets the given state, so repeating the call keeps it', async () => {
    const { projectUpdate, run } = setup(true);

    expect((await run({ fileId: 'file-1', enabled: false })).systemPrompts[0].enabled).toBe(false);
    expect((await run({ fileId: 'file-1', enabled: false })).systemPrompts[0].enabled).toBe(false);
    expect(projectUpdate).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the prompt already has the given state', async () => {
    const { projectUpdate, run } = setup(true);

    const project = await run({ fileId: 'file-1', enabled: true });

    expect(project.systemPrompts[0].enabled).toBe(true);
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('answers 404 for a file that is not a system prompt', async () => {
    const { projectUpdate, run } = setup(true);

    await expect(run({ fileId: 'file-2', enabled: false })).rejects.toThrow(NotFoundError);
    expect(projectUpdate).not.toHaveBeenCalled();
  });
});
