import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { get } from './get';
import { IUserDocument } from '@bike4mind/common';
import { mockResearchAgent } from '../__tests__/utils/testUtils';

describe('researchAgentService - get', () => {
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
      findByIdAndUserId: vi.fn(),
    };
    adapters = {
      db: {
        researchAgents: mockResearchAgentRepo,
      },
    };
  });

  it('should get a research agent by id', async () => {
    // Arrange
    const agentId = 'test-agent-id';
    const expectedAgent = mockResearchAgent({
      id: agentId,
      userId: mockUser.id,
    });

    (mockResearchAgentRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(expectedAgent);

    // Act
    const result = await get(mockUser, { id: agentId }, adapters);

    // Assert
    expect(result).toEqual(expectedAgent);
    expect(mockResearchAgentRepo.findByIdAndUserId).toHaveBeenCalledWith(agentId, mockUser.id);
  });

  it('should throw error when research agent is not found', async () => {
    // Arrange
    const nonExistentId = 'non-existent-id';
    (mockResearchAgentRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(get(mockUser, { id: nonExistentId }, adapters)).rejects.toThrow('Research agent not found');
  });

  it('should throw validation error for invalid id', async () => {
    // Arrange
    const invalidParams = {
      id: '', // Invalid: empty string
    };

    // Act & Assert
    await expect(get(mockUser, invalidParams, adapters)).rejects.toThrow();
  });

  it('should throw validation error when id is missing', async () => {
    // Arrange
    const incompleteParams = {
      // Missing id
    };

    // Act & Assert
    await expect(get(mockUser, incompleteParams as any, adapters)).rejects.toThrow();
  });
});
