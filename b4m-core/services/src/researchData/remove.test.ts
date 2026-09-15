import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import { remove } from './remove';
import {
  IResearchAgentRepository,
  IResearchDataRepository,
  IOrganizationRepository,
  IUserRepository,
} from '@bike4mind/common';

vi.mock('../fabFileService/delete', () => ({
  deleteFabFile: vi.fn(),
}));

// Mock must be imported after vi.mock for type inference
import { deleteFabFile } from '../fabFileService/delete';

describe('researchDataService - remove', () => {
  const mockUserId = 'user-123';
  const mockResearchAgentId = 'agent-123';
  const mockResearchDataId = 'data-123';
  const mockFabFileId = 'fab-123';

  let mockResearchAgentRepo: {
    findByIdAndUserId: Mock;
  };
  let mockResearchDataRepo: {
    findByIdAndResearchAgentId: Mock;
    delete: Mock;
  };
  let mockOrganizationRepo: {
    incrementCurrentStorage: Mock;
  };
  let mockUserRepo: {
    incrementCurrentStorage: Mock;
  };
  let adapters: {
    db: {
      researchAgents: IResearchAgentRepository;
      researchDatas: IResearchDataRepository;
      organizations: IOrganizationRepository;
      users: IUserRepository;
      fabFiles: {
        findByIdAndUserId: Mock;
        findById: Mock;
        findAllInIds: Mock;
        update: Mock;
        deleteManyInIds: Mock;
      };
      fabFileChunks: {
        deleteManyByFabFileId: Mock;
      };
      sessions: {
        findById: Mock;
        findAllWithKnowledgeId: Mock;
        update: Mock;
      };
    };
    storage: {
      delete: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockResearchAgentRepo = {
      findByIdAndUserId: vi.fn(),
    };
    mockResearchDataRepo = {
      findByIdAndResearchAgentId: vi.fn(),
      delete: vi.fn(),
    };
    mockOrganizationRepo = {
      incrementCurrentStorage: vi.fn(),
    };
    mockUserRepo = {
      incrementCurrentStorage: vi.fn(),
    };
    adapters = {
      db: {
        researchAgents: mockResearchAgentRepo as unknown as IResearchAgentRepository,
        researchDatas: mockResearchDataRepo as unknown as IResearchDataRepository,
        organizations: mockOrganizationRepo as unknown as IOrganizationRepository,
        users: mockUserRepo as unknown as IUserRepository,
        fabFiles: {
          findByIdAndUserId: vi.fn(),
          findById: vi.fn(),
          findAllInIds: vi.fn(),
          update: vi.fn(),
          deleteManyInIds: vi.fn(),
        },
        fabFileChunks: {
          deleteManyByFabFileId: vi.fn(),
        },
        sessions: {
          findById: vi.fn(),
          findAllWithKnowledgeId: vi.fn(),
          update: vi.fn(),
        },
      },
      storage: {
        delete: vi.fn(),
      },
    };
  });

  it('should successfully remove research data with organization file', async () => {
    // Arrange
    const params = { id: mockResearchDataId, researchAgentId: mockResearchAgentId };
    const mockResearchAgent = { id: mockResearchAgentId };
    const mockResearchData = { id: mockResearchDataId, fabFileId: mockFabFileId };
    const mockFabFile = {
      id: mockFabFileId,
      userId: mockUserId,
      organizationId: 'org-123',
      fileSize: 1024,
    };

    mockResearchAgentRepo.findByIdAndUserId.mockResolvedValueOnce(mockResearchAgent);
    mockResearchDataRepo.findByIdAndResearchAgentId.mockResolvedValueOnce(mockResearchData);
    mockResearchDataRepo.delete.mockResolvedValueOnce(undefined);
    (deleteFabFile as Mock).mockResolvedValueOnce({ action: 'deleted', fabFile: mockFabFile });
    mockOrganizationRepo.incrementCurrentStorage.mockResolvedValueOnce(undefined);

    // Act
    await remove(mockUserId, params, adapters);

    // Assert
    expect(mockResearchAgentRepo.findByIdAndUserId).toHaveBeenCalledWith(mockResearchAgentId, mockUserId);
    expect(mockResearchDataRepo.findByIdAndResearchAgentId).toHaveBeenCalledWith(
      mockResearchDataId,
      mockResearchAgentId
    );
    expect(mockResearchDataRepo.delete).toHaveBeenCalledWith(mockResearchDataId);
    expect(deleteFabFile).toHaveBeenCalledWith(mockUserId, { id: mockFabFileId }, adapters);
    expect(mockOrganizationRepo.incrementCurrentStorage).toHaveBeenCalledWith('org-123', -1024);
    expect(mockUserRepo.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('should throw NotFoundError when research agent is not found', async () => {
    // Arrange
    const params = { id: mockResearchDataId, researchAgentId: mockResearchAgentId };
    mockResearchAgentRepo.findByIdAndUserId.mockResolvedValueOnce(null);

    // Act & Assert
    const promise = remove(mockUserId, params, adapters);
    await expect(promise).rejects.toThrow(NotFoundError);
    await expect(promise).rejects.toThrow('Research data not found');
    expect(mockResearchDataRepo.findByIdAndResearchAgentId).not.toHaveBeenCalled();
    expect(mockResearchDataRepo.delete).not.toHaveBeenCalled();
    expect(deleteFabFile).not.toHaveBeenCalled();
  });

  it('should throw NotFoundError when research data is not found', async () => {
    // Arrange
    const params = { id: mockResearchDataId, researchAgentId: mockResearchAgentId };
    const mockResearchAgent = { id: mockResearchAgentId };
    mockResearchAgentRepo.findByIdAndUserId.mockResolvedValueOnce(mockResearchAgent);
    mockResearchDataRepo.findByIdAndResearchAgentId.mockResolvedValueOnce(null);

    // Act & Assert
    const promise = remove(mockUserId, params, adapters);
    await expect(promise).rejects.toThrow(NotFoundError);
    await expect(promise).rejects.toThrow('Research data not found');
    expect(mockResearchDataRepo.delete).not.toHaveBeenCalled();
    expect(deleteFabFile).not.toHaveBeenCalled();
  });

  it('should throw a validation error for invalid parameters', async () => {
    // Arrange
    const invalidParams = {} as any; // Invalid: missing required fields

    // Act & Assert
    // secureParameters throws an error before the function body executes fully
    const promise = remove(mockUserId, invalidParams, adapters);
    await expect(promise).rejects.toThrow(/Invalid input/);
    expect(mockResearchDataRepo.delete).not.toHaveBeenCalled();
    expect(deleteFabFile).not.toHaveBeenCalled();
  });

  it('should successfully remove research data with user-owned file', async () => {
    // Arrange
    const params = { id: mockResearchDataId, researchAgentId: mockResearchAgentId };
    const mockResearchAgent = { id: mockResearchAgentId };
    const mockResearchData = { id: mockResearchDataId, fabFileId: mockFabFileId };
    const mockFabFile = {
      id: mockFabFileId,
      userId: mockUserId,
      organizationId: null,
      fileSize: 2048,
    };

    mockResearchAgentRepo.findByIdAndUserId.mockResolvedValueOnce(mockResearchAgent);
    mockResearchDataRepo.findByIdAndResearchAgentId.mockResolvedValueOnce(mockResearchData);
    mockResearchDataRepo.delete.mockResolvedValueOnce(undefined);
    (deleteFabFile as Mock).mockResolvedValueOnce({ action: 'deleted', fabFile: mockFabFile });
    mockUserRepo.incrementCurrentStorage.mockResolvedValueOnce(undefined);

    // Act
    await remove(mockUserId, params, adapters);

    // Assert
    expect(mockResearchDataRepo.delete).toHaveBeenCalledWith(mockResearchDataId);
    expect(deleteFabFile).toHaveBeenCalledWith(mockUserId, { id: mockFabFileId }, adapters);
    expect(mockUserRepo.incrementCurrentStorage).toHaveBeenCalledWith(mockUserId, -2048);
    expect(mockOrganizationRepo.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('should remove research data even when fabFile is not found', async () => {
    // Arrange
    const params = { id: mockResearchDataId, researchAgentId: mockResearchAgentId };
    const mockResearchAgent = { id: mockResearchAgentId };
    const mockResearchData = { id: mockResearchDataId, fabFileId: mockFabFileId };

    mockResearchAgentRepo.findByIdAndUserId.mockResolvedValueOnce(mockResearchAgent);
    mockResearchDataRepo.findByIdAndResearchAgentId.mockResolvedValueOnce(mockResearchData);
    mockResearchDataRepo.delete.mockResolvedValueOnce(undefined);
    (deleteFabFile as Mock).mockResolvedValueOnce({ action: 'not_found', fabFile: null });

    // Act
    await remove(mockUserId, params, adapters);

    // Assert
    expect(mockResearchDataRepo.delete).toHaveBeenCalledWith(mockResearchDataId);
    expect(deleteFabFile).toHaveBeenCalledWith(mockUserId, { id: mockFabFileId }, adapters);
    expect(mockOrganizationRepo.incrementCurrentStorage).not.toHaveBeenCalled();
    expect(mockUserRepo.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('should handle fabFile owned by different user', async () => {
    // Arrange
    const params = { id: mockResearchDataId, researchAgentId: mockResearchAgentId };
    const mockResearchAgent = { id: mockResearchAgentId };
    const mockResearchData = { id: mockResearchDataId, fabFileId: mockFabFileId };

    mockResearchAgentRepo.findByIdAndUserId.mockResolvedValueOnce(mockResearchAgent);
    mockResearchDataRepo.findByIdAndResearchAgentId.mockResolvedValueOnce(mockResearchData);
    mockResearchDataRepo.delete.mockResolvedValueOnce(undefined);
    (deleteFabFile as Mock).mockResolvedValueOnce({ action: 'not_found', fabFile: null }); // File not owned by user

    // Act
    await remove(mockUserId, params, adapters);

    // Assert
    expect(mockResearchDataRepo.delete).toHaveBeenCalledWith(mockResearchDataId);
    expect(deleteFabFile).toHaveBeenCalledWith(mockUserId, { id: mockFabFileId }, adapters);
    expect(mockOrganizationRepo.incrementCurrentStorage).not.toHaveBeenCalled();
    expect(mockUserRepo.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('should handle organization file with undefined organizationId', async () => {
    // Arrange
    const params = { id: mockResearchDataId, researchAgentId: mockResearchAgentId };
    const mockResearchAgent = { id: mockResearchAgentId };
    const mockResearchData = { id: mockResearchDataId, fabFileId: mockFabFileId };
    const mockFabFile = {
      id: mockFabFileId,
      userId: mockUserId,
      organizationId: undefined,
      fileSize: 512,
    };

    mockResearchAgentRepo.findByIdAndUserId.mockResolvedValueOnce(mockResearchAgent);
    mockResearchDataRepo.findByIdAndResearchAgentId.mockResolvedValueOnce(mockResearchData);
    mockResearchDataRepo.delete.mockResolvedValueOnce(undefined);
    (deleteFabFile as Mock).mockResolvedValueOnce({ action: 'deleted', fabFile: mockFabFile });
    mockUserRepo.incrementCurrentStorage.mockResolvedValueOnce(undefined);

    // Act
    await remove(mockUserId, params, adapters);

    // Assert
    expect(mockUserRepo.incrementCurrentStorage).toHaveBeenCalledWith(mockUserId, -512);
    expect(mockOrganizationRepo.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('should handle storage management errors gracefully', async () => {
    // Arrange
    const params = { id: mockResearchDataId, researchAgentId: mockResearchAgentId };
    const mockResearchAgent = { id: mockResearchAgentId };
    const mockResearchData = { id: mockResearchDataId, fabFileId: mockFabFileId };
    const mockFabFile = {
      id: mockFabFileId,
      userId: mockUserId,
      organizationId: 'org-123',
      fileSize: 1024,
    };

    mockResearchAgentRepo.findByIdAndUserId.mockResolvedValueOnce(mockResearchAgent);
    mockResearchDataRepo.findByIdAndResearchAgentId.mockResolvedValueOnce(mockResearchData);
    mockResearchDataRepo.delete.mockResolvedValueOnce(undefined);
    (deleteFabFile as Mock).mockResolvedValueOnce({ action: 'deleted', fabFile: mockFabFile });
    mockOrganizationRepo.incrementCurrentStorage.mockRejectedValueOnce(new Error('Storage update failed'));

    // Act & Assert
    const promise = remove(mockUserId, params, adapters);
    await expect(promise).rejects.toThrow('Storage update failed');

    // Verify that research data and fab file deletion still occurred
    expect(mockResearchDataRepo.delete).toHaveBeenCalledWith(mockResearchDataId);
    expect(deleteFabFile).toHaveBeenCalledWith(mockUserId, { id: mockFabFileId }, adapters);
  });

  it('should handle fabFilesService.deleteFabFile errors', async () => {
    // Arrange
    const params = { id: mockResearchDataId, researchAgentId: mockResearchAgentId };
    const mockResearchAgent = { id: mockResearchAgentId };
    const mockResearchData = { id: mockResearchDataId, fabFileId: mockFabFileId };
    const mockFabFile = {
      id: mockFabFileId,
      userId: mockUserId,
      organizationId: null,
      fileSize: 1024,
    };

    mockResearchAgentRepo.findByIdAndUserId.mockResolvedValueOnce(mockResearchAgent);
    mockResearchDataRepo.findByIdAndResearchAgentId.mockResolvedValueOnce(mockResearchData);
    mockResearchDataRepo.delete.mockResolvedValueOnce(undefined);
    adapters.db.fabFiles.findByIdAndUserId.mockResolvedValueOnce(mockFabFile);
    (deleteFabFile as Mock).mockRejectedValueOnce(new Error('FabFile deletion failed'));

    // Act & Assert
    const promise = remove(mockUserId, params, adapters);
    await expect(promise).rejects.toThrow('FabFile deletion failed');

    // Verify that research data deletion still occurred
    expect(mockResearchDataRepo.delete).toHaveBeenCalledWith(mockResearchDataId);
  });
});
