import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { remove } from './remove';
import { IUserDocument } from '@bike4mind/common';
import { mockResearchAgent } from '../__tests__/utils/testUtils';

describe('researchAgentService - remove', () => {
  const mockUser = {
    id: 'test-user-123',
    email: 'test@example.com',
    name: 'Test User',
    username: 'testuser',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IUserDocument;

  let mockResearchAgentRepo: any;
  let mockResearchTaskRepo: any;
  let adapters: any;

  beforeEach(() => {
    mockResearchAgentRepo = {
      findByIdAndUserId: vi.fn(),
      update: vi.fn(),
    };
    mockResearchTaskRepo = {
      updateManyByResearchAgentId: vi.fn(),
    };
    adapters = {
      db: {
        researchAgents: mockResearchAgentRepo,
        researchTasks: mockResearchTaskRepo,
      },
    };
  });

  it('should soft delete a research agent and its associated tasks', async () => {
    // Arrange
    const agentId = 'test-agent-id';
    const existingAgent = mockResearchAgent({
      id: agentId,
      userId: mockUser.id,
    });

    (mockResearchAgentRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingAgent);
    (mockResearchAgentRepo.update as Mock).mockResolvedValueOnce({ ...existingAgent, deletedAt: expect.any(Date) });
    (mockResearchTaskRepo.updateManyByResearchAgentId as Mock).mockResolvedValueOnce(undefined);

    // Act
    const result = await remove(mockUser, { id: agentId }, adapters);

    // Assert
    expect(result.deletedAt).toBeDefined();
    expect(mockResearchAgentRepo.findByIdAndUserId).toHaveBeenCalledWith(agentId, mockUser.id);
    expect(mockResearchAgentRepo.update).toHaveBeenCalledWith({
      ...existingAgent,
      deletedAt: expect.any(Date),
    });
    expect(mockResearchTaskRepo.updateManyByResearchAgentId).toHaveBeenCalledWith(agentId, {
      deletedAt: expect.any(Date),
    });
  });

  it('should throw error when research agent is not found', async () => {
    // Arrange
    const nonExistentId = 'non-existent-id';
    (mockResearchAgentRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(remove(mockUser, { id: nonExistentId }, adapters)).rejects.toThrow('Research agent not found');
    expect(mockResearchTaskRepo.updateManyByResearchAgentId).not.toHaveBeenCalled();
  });

  it('should throw validation error for invalid id', async () => {
    // Arrange
    const invalidParams = {
      id: '', // Invalid: empty string
    };

    // Act & Assert
    await expect(remove(mockUser, invalidParams, adapters)).rejects.toThrow();
    expect(mockResearchTaskRepo.updateManyByResearchAgentId).not.toHaveBeenCalled();
  });
});
