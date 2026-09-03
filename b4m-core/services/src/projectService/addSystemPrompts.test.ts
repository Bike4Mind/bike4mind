import { describe, it, expect, beforeEach, Mock } from 'vitest';
import { addSystemPrompts } from './addSystemPrompts';
import { createMockProjectRepository, createMockFabFileRepository } from '../__tests__/utils/testUtils';
import { IProjectDocument, IProjectRepository, IFabFileRepository, IUserDocument } from '@bike4mind/common';

const HEX_A = '507f1f77bcf86cd799439011';
const HEX_B = '507f1f77bcf86cd799439022';
const HEX_C = '507f1f77bcf86cd799439033';

describe('projectService - addSystemPrompts', () => {
  const user = { id: 'user-1' } as IUserDocument;
  let mockProjectRepo: IProjectRepository;
  let mockFabFileRepo: IFabFileRepository;
  let adapters: { db: { projects: IProjectRepository; fabFiles: IFabFileRepository } };

  const projectWith = (promptIds: string[]): IProjectDocument =>
    ({
      id: 'project-1',
      name: 'Test Project',
      description: 'd',
      isGlobalRead: false,
      isGlobalWrite: false,
      userId: user.id,
      sessionIds: [],
      fileIds: [],
      systemPrompts: promptIds.map(fileId => ({ fileId, enabled: true })),
      users: [],
      groups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as IProjectDocument;

  const filesFor = (ids: string[]) => ids.map(id => ({ id, userId: user.id, users: [], groups: [] }));

  beforeEach(() => {
    mockProjectRepo = createMockProjectRepository();
    mockFabFileRepo = createMockFabFileRepository();
    adapters = { db: { projects: mockProjectRepo, fabFiles: mockFabFileRepo } };
    (mockProjectRepo.update as Mock).mockImplementation(async p => p);
    (mockFabFileRepo.update as Mock).mockImplementation(async f => f);
  });

  it('stores prompts in the order requested, not the order Mongo returned them', async () => {
    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(projectWith([]));
    // The reader returns rows in its own order; the request order is the one composition uses.
    (mockFabFileRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(filesFor([HEX_A, HEX_B, HEX_C]));

    const result = await addSystemPrompts(user, { projectId: 'project-1', fileIds: [HEX_C, HEX_A, HEX_B] }, adapters);

    expect(result.systemPrompts.map(p => p.fileId)).toEqual([HEX_C, HEX_A, HEX_B]);
  });

  it('does not re-add a file whose existing prompt is stored in uppercase hex', async () => {
    // A legacy systemPrompts row naming the same file in the other hex case.
    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(projectWith([HEX_A.toUpperCase()]));
    (mockFabFileRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(filesFor([HEX_A]));

    await expect(addSystemPrompts(user, { projectId: 'project-1', fileIds: [HEX_A] }, adapters)).rejects.toThrow(
      'All files are already added as system prompts'
    );
  });
});
