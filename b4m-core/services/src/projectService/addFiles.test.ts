import { describe, it, expect, beforeEach, Mock } from 'vitest';
import { addFiles } from './addFiles';
import { createMockProjectRepository, createMockFabFileRepository } from '../__tests__/utils/testUtils';
import { IFabFileRepository, IProjectRepository, IUserDocument, Permission } from '@bike4mind/common';

// TODO: Skipped temporarily due to test failures that need fixing
describe.skip('projectService - addFiles', () => {
  const contributorId = 'contributor-123';
  let mockProjectRepo: IProjectRepository;
  let mockFabFileRepo: IFabFileRepository;
  let adapters: { db: { projects: IProjectRepository; fabFiles: IFabFileRepository } };

  beforeEach(() => {
    mockProjectRepo = createMockProjectRepository();
    mockFabFileRepo = createMockFabFileRepository();
    adapters = {
      db: {
        projects: mockProjectRepo,
        fabFiles: mockFabFileRepo,
      },
    };
  });

  it('should add files to a project and share with project owner', async () => {
    const projectOwnerId = 'project-owner-123';
    const projectId = 'test-project-id';
    const fileIds = ['file-1', 'file-2'];
    const existingFileIds = ['existing-file-1'];

    const mockUser = {
      id: contributorId,
      name: 'Contributor',
    } as IUserDocument;

    const mockProject = {
      id: projectId,
      name: 'Test Project',
      description: 'Test Description',
      userId: projectOwnerId,
      fileIds: existingFileIds,
      sessionIds: [],
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [{ userId: contributorId, permissions: [Permission.read] }],
      groups: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockFiles = fileIds.map(id => ({
      id,
      name: `File ${id}`,
      userId: contributorId,
      createdAt: new Date(),
      updatedAt: new Date(),
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
    }));

    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(mockProject);
    (mockFabFileRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(mockFiles);

    const result = await addFiles(mockUser, { projectId, fileIds }, adapters);

    expect(result).toEqual(mockProject);

    expect(mockProjectRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...mockProject,
        fileIds: expect.arrayContaining([...existingFileIds, ...fileIds]),
        updatedAt: expect.any(Date),
      })
    );

    for (const file of mockFiles) {
      expect(mockFabFileRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          ...file,
          users: expect.arrayContaining([
            { userId: projectOwnerId, permissions: [Permission.read], projectId },
            { userId: contributorId, permissions: [Permission.read], projectId },
          ]),
        })
      );
    }
  });

  it('should throw error when project is not found', async () => {
    const mockUser = { id: contributorId } as IUserDocument;
    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(null);

    await expect(addFiles(mockUser, { projectId: 'any', fileIds: ['any'] }, adapters)).rejects.toThrow(
      'Project not found'
    );
  });

  it('should throw error when some files are not accessible', async () => {
    const mockUser = { id: contributorId } as IUserDocument;
    const mockProject = { id: 'project-1', userId: 'owner-1' };
    const fileIds = ['file-1', 'file-2'];
    const mockFiles = [{ id: 'file-1' }]; // Only one file found

    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValueOnce(mockProject);
    (mockFabFileRepo.shareable.findAllAccessibleByIds as Mock).mockResolvedValueOnce(mockFiles);

    await expect(addFiles(mockUser, { projectId: 'any', fileIds }, adapters)).rejects.toThrow(
      'Some files are not accessible'
    );
  });

  it('should throw validation error for invalid parameters', async () => {
    const mockUser = { id: contributorId } as IUserDocument;
    const invalidParams = {
      projectId: '', // Invalid: empty string
      fileIds: [], // Invalid: empty array
    };

    await expect(addFiles(mockUser, invalidParams, adapters)).rejects.toThrow();

    expect(mockProjectRepo.shareable.findAccessibleById).not.toHaveBeenCalled();
    expect(mockFabFileRepo.shareable.findAllAccessibleByIds).not.toHaveBeenCalled();
    expect(mockProjectRepo.update).not.toHaveBeenCalled();
  });
});
