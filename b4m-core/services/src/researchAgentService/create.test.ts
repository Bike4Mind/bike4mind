import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { create } from './create';
import { IResearchAgent } from '@bike4mind/common';
import { IUserDocument } from '@bike4mind/common';

describe('researchAgentService - create', () => {
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
      create: vi.fn(),
    };
    adapters = {
      db: {
        researchAgents: mockResearchAgentRepo,
      },
    };
  });

  it('should create a research agent with valid parameters', async () => {
    // Arrange
    const createParams = {
      name: 'Test Agent',
      description: 'Test Description',
    };

    const expectedAgent: IResearchAgent = {
      id: 'test-agent-id',
      ...createParams,
      userId: mockUser.id,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    };

    (mockResearchAgentRepo.create as Mock).mockResolvedValueOnce(expectedAgent);

    // Act
    const result = await create(mockUser, createParams, adapters);

    // Assert
    expect(result).toEqual(expectedAgent);
    expect(mockResearchAgentRepo.create).toHaveBeenCalledWith({
      name: createParams.name,
      description: createParams.description,
      userId: mockUser.id,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('should throw validation error for invalid parameters', async () => {
    // Arrange
    const invalidParams = {
      name: '', // Invalid: empty string
      description: '', // Invalid: empty string
    };

    // Act & Assert
    await expect(create(mockUser, invalidParams, adapters)).rejects.toThrow();
  });

  it('should throw validation error when parameters are missing', async () => {
    // Arrange
    const incompleteParams = {
      name: 'Test Agent',
      // Missing description
    };

    // Act & Assert
    await expect(create(mockUser, incompleteParams as any, adapters)).rejects.toThrow();
  });
});
