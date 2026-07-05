import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { update } from './update';
import { IUserDocument } from '@bike4mind/common';
import { mockResearchAgent } from '../__tests__/utils/testUtils';

describe('researchAgentService - update', () => {
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
      update: vi.fn(),
    };
    adapters = {
      db: {
        researchAgents: mockResearchAgentRepo,
      },
    };
  });

  it('should update a research agent with valid parameters', async () => {
    // Arrange
    const agentId = 'test-agent-id';
    const existingAgent = mockResearchAgent({
      id: agentId,
      userId: mockUser.id,
      name: 'Old Name',
      description: 'Old Description',
    });

    const updateParams = {
      id: agentId,
      name: 'New Name',
      description: 'New Description',
    };

    const expectedAgent = {
      ...existingAgent,
      name: updateParams.name,
      description: updateParams.description,
      updatedAt: expect.any(Date),
    };

    (mockResearchAgentRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingAgent);
    (mockResearchAgentRepo.update as Mock).mockResolvedValueOnce(expectedAgent);

    // Act
    const result = await update(mockUser, updateParams, adapters);

    // Assert
    expect(result).toEqual(expectedAgent);
    expect(mockResearchAgentRepo.findByIdAndUserId).toHaveBeenCalledWith(agentId, mockUser.id);
    expect(mockResearchAgentRepo.update).toHaveBeenCalledWith({
      ...existingAgent,
      name: updateParams.name,
      description: updateParams.description,
      updatedAt: expect.any(Date),
    });
  });

  it('should throw error when research agent is not found', async () => {
    // Arrange
    const updateParams = {
      id: 'non-existent-id',
      name: 'New Name',
      description: 'New Description',
    };
    (mockResearchAgentRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(update(mockUser, updateParams, adapters)).rejects.toThrow('Research agent not found');
  });

  it('should throw validation error for invalid parameters', async () => {
    // Arrange
    const invalidParams = {
      id: 'test-id',
      name: '', // Invalid: empty string
      description: '', // Invalid: empty string
    };

    // Act & Assert
    await expect(update(mockUser, invalidParams, adapters)).rejects.toThrow();
  });

  it('should throw validation error when parameters are missing', async () => {
    // Arrange
    const incompleteParams = {
      id: 'test-id',
      name: 'New Name',
      // Missing description
    };

    // Act & Assert
    await expect(update(mockUser, incompleteParams as any, adapters)).rejects.toThrow();
  });
});
