import { describe, it, expect, beforeEach, Mock } from 'vitest';
import { removeSystemPrompts } from './removeSystemPrompts';
import { createMockProjectRepository, createMockFabFileRepository } from '../__tests__/utils/testUtils';
import { IProjectDocument, IProjectRepository, IFabFileRepository, IUserDocument } from '@bike4mind/common';

describe('projectService - removeSystemPrompts', () => {
  const user = { id: 'user-1' } as IUserDocument;
  let mockProjectRepo: IProjectRepository;
  let mockFabFileRepo: IFabFileRepository;
  let adapters: { db: { projects: IProjectRepository; fabFiles: IFabFileRepository } };

  const projectWith = (fileIds: string[]): IProjectDocument =>
    ({
      id: 'project-1',
      name: 'Test Project',
      userId: user.id,
      sessionIds: [],
      fileIds: [],
      systemPrompts: fileIds.map(fileId => ({ fileId, enabled: true })),
      users: [],
      groups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as IProjectDocument;

  beforeEach(() => {
    mockProjectRepo = createMockProjectRepository();
    mockFabFileRepo = createMockFabFileRepository();
    adapters = { db: { projects: mockProjectRepo, fabFiles: mockFabFileRepo } };
    (mockProjectRepo.update as Mock).mockImplementation(async p => p);
  });

  it('removes multiple prompts in a single update', async () => {
    const project = projectWith(['a', 'b', 'c']);
    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(project);

    const result = await removeSystemPrompts(user, { projectId: 'project-1', fileIds: ['a', 'c'] }, adapters);

    expect(result.systemPrompts).toEqual([{ fileId: 'b', enabled: true }]);
    expect(mockProjectRepo.update).toHaveBeenCalledTimes(1);
  });

  it('supports a single-id array (legacy path)', async () => {
    const project = projectWith(['a', 'b']);
    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(project);

    const result = await removeSystemPrompts(user, { projectId: 'project-1', fileIds: ['a'] }, adapters);

    expect(result.systemPrompts).toEqual([{ fileId: 'b', enabled: true }]);
  });

  it('is idempotent when an id is not present', async () => {
    const project = projectWith(['a', 'b']);
    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(project);

    const result = await removeSystemPrompts(user, { projectId: 'project-1', fileIds: ['missing'] }, adapters);

    expect(result.systemPrompts).toEqual([
      { fileId: 'a', enabled: true },
      { fileId: 'b', enabled: true },
    ]);
    expect(mockProjectRepo.update).toHaveBeenCalledTimes(1);
  });

  it('throws when the project is not accessible', async () => {
    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(null);

    await expect(removeSystemPrompts(user, { projectId: 'missing', fileIds: ['a'] }, adapters)).rejects.toThrow(
      'Project not found'
    );
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
  });
});
