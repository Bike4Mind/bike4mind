import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { get } from './get';
import { IResearchTask, IResearchData } from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';
import { mockResearchTask } from '../__tests__/utils/testUtils';

describe('researchTaskService - get', () => {
  const mockUser = {
    id: 'test-user-123',
    email: 'test@example.com',
    name: 'Test User',
    username: 'testuser',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IUserDocument;

  let mockResearchTaskRepo: any;
  let mockResearchDataRepo: any;
  let adapters: any;

  beforeEach(() => {
    mockResearchTaskRepo = {
      findByIdAndUserId: vi.fn(),
    };
    mockResearchDataRepo = {
      findAllByResearchTaskIdWithFiles: vi.fn(),
    };
    adapters = {
      db: {
        researchTasks: mockResearchTaskRepo,
        researchData: mockResearchDataRepo,
      },
      storage: {
        generateSignedUrl: vi
          .fn()
          .mockResolvedValue('https://files.test/signed?X-Amz-Date=20260101T000000Z&X-Amz-Expires=3600'),
      },
    };
  });

  it('should get a research task by id', async () => {
    // Arrange
    const taskId = 'test-task-id';
    const expectedTask: IResearchTask = mockResearchTask({
      id: taskId,
    });

    const mockResearchData = [
      {
        id: 'research-data-1',
        fabFileId: 'fab-file-1',
        fabFile: {
          id: 'fab-file-1',
          filePath: 'files/a.pdf',
          mimeType: 'application/pdf',
          moderationStatus: 'clean',
          fileUrl: 'https://stale.test/old',
        },
        researchAgentId: expectedTask.researchAgentId,
        researchTaskId: taskId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as unknown as IResearchData[];

    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(expectedTask);
    (mockResearchDataRepo.findAllByResearchTaskIdWithFiles as Mock).mockResolvedValueOnce(mockResearchData);

    // Act
    const result = await get(mockUser, { id: taskId }, adapters);

    // Assert
    expect(result.researchData).toHaveLength(1);
    expect(result.researchData[0].fabFile.fileUrl).toBe(
      'https://files.test/signed?X-Amz-Date=20260101T000000Z&X-Amz-Expires=3600'
    );
    expect(result.researchData[0].fabFile.fileUrlExpireAt).toBeInstanceOf(Date);
    expect(adapters.storage.generateSignedUrl).toHaveBeenCalledWith('files/a.pdf', expect.any(Number), {
      signingDate: expect.any(Date),
    });
    expect(result).toMatchObject({ ...expectedTask, researchData: [{ id: 'research-data-1' }] });
    expect(mockResearchTaskRepo.findByIdAndUserId).toHaveBeenCalledWith(taskId, mockUser.id);
    expect(mockResearchDataRepo.findAllByResearchTaskIdWithFiles).toHaveBeenCalledWith(taskId);
  });

  it('should throw error when research task is not found', async () => {
    // Arrange
    const taskId = 'non-existent-task';
    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(get(mockUser, { id: taskId }, adapters)).rejects.toThrow('Research task not found');
  });

  it('does not sign anything when the task is not found', async () => {
    (mockResearchTaskRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);
    await expect(get(mockUser, { id: 'x' }, adapters)).rejects.toThrow();
    expect(mockResearchDataRepo.findAllByResearchTaskIdWithFiles).not.toHaveBeenCalled();
    expect(adapters.storage.generateSignedUrl).not.toHaveBeenCalled();
  });

  it('should throw validation error for invalid parameters', async () => {
    // Arrange
    const invalidParams = {
      id: '', // Invalid: empty string
    };

    // Act & Assert
    await expect(get(mockUser, invalidParams, adapters)).rejects.toThrow();
  });
});
