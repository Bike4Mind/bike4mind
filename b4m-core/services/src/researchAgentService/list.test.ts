import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { list } from './list';
import { IResearchAgent } from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';

describe('researchAgentService - list', () => {
  const mockUser = {
    id: 'test-user-123',
    email: 'test@example.com',
    name: 'Test User',
    username: 'testuser',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IUserDocument;

  let mockResearchAgentRepo: any;
  let adapters: any;

  beforeEach(() => {
    mockResearchAgentRepo = {
      findAllByUserId: vi.fn(),
    };
    adapters = {
      db: {
        researchAgents: mockResearchAgentRepo,
      },
    };
  });

  it('should return all research agents for the user', async () => {
    // Arrange
    const mockAgents: IResearchAgent[] = [
      {
        id: 'agent-1',
        name: 'Test Agent 1',
        description: 'Description 1',
        userId: mockUser.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'agent-2',
        name: 'Test Agent 2',
        description: 'Description 2',
        userId: mockUser.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    (mockResearchAgentRepo.findAllByUserId as Mock).mockResolvedValueOnce(mockAgents);

    // Act
    const result = await list(mockUser, adapters);

    // Assert
    expect(result).toEqual(mockAgents);
    expect(mockResearchAgentRepo.findAllByUserId).toHaveBeenCalledWith(mockUser.id);
    expect(mockResearchAgentRepo.findAllByUserId).toHaveBeenCalledTimes(1);
  });

  it('should return empty array when user has no research agents', async () => {
    // Arrange
    (mockResearchAgentRepo.findAllByUserId as Mock).mockResolvedValueOnce([]);

    // Act
    const result = await list(mockUser, adapters);

    // Assert
    expect(result).toEqual([]);
    expect(mockResearchAgentRepo.findAllByUserId).toHaveBeenCalledWith(mockUser.id);
    expect(mockResearchAgentRepo.findAllByUserId).toHaveBeenCalledTimes(1);
  });

  it('should propagate repository errors', async () => {
    // Arrange
    const mockError = new Error('Database error');
    (mockResearchAgentRepo.findAllByUserId as Mock).mockRejectedValueOnce(mockError);

    // Act & Assert
    await expect(list(mockUser, adapters)).rejects.toThrow(mockError);
    expect(mockResearchAgentRepo.findAllByUserId).toHaveBeenCalledWith(mockUser.id);
    expect(mockResearchAgentRepo.findAllByUserId).toHaveBeenCalledTimes(1);
  });
});
