import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { IResearchAgent } from '@bike4mind/common';
import { researchAgentRepository } from './ResearchAgentModel';
import { setupMongoTest } from '../../__test__/utils';

describe('ResearchAgentRepository', () => {
  const userId = new mongoose.Types.ObjectId().toString();

  setupMongoTest();

  describe('findByIdAndUserId', () => {
    it('should find agent by id and userId', async () => {
      // Arrange
      const agentData: Omit<IResearchAgent, 'id' | 'createdAt' | 'updatedAt'> = {
        name: 'Test Agent',
        description: 'Test Description',
        userId,
      };
      const agent = await researchAgentRepository.create(agentData);

      // Act
      const result = await researchAgentRepository.findByIdAndUserId(agent.id, userId);

      // Assert
      expect(result).toMatchObject({
        ...agentData,
        id: agent.id,
      });
    });

    it('should return null when agent not found by id', async () => {
      // Arrange
      const nonExistentId = new mongoose.Types.ObjectId().toString();

      // Act
      const result = await researchAgentRepository.findByIdAndUserId(nonExistentId, userId);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when agent belongs to different user', async () => {
      // Arrange
      const otherUserId = new mongoose.Types.ObjectId().toString();
      const agent = await researchAgentRepository.create({
        name: 'Test Agent',
        description: 'Test Description',
        userId: otherUserId,
      });

      // Act
      const result = await researchAgentRepository.findByIdAndUserId(agent.id, userId);

      // Assert
      expect(result).toBeNull();
    });
  });
});
