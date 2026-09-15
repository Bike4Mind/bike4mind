import {
  IResearchTask,
  ResearchTaskStatus,
  ResearchTaskType,
  ResearchTaskExecutionType,
  IResearchAgent,
} from '@bike4mind/common';

/**
 * Mock a research task
 * @param value - Partial<IResearchTask> - The value to override the default data
 * @returns IResearchTask - The mock research task
 */
export const mockResearchTask = (value: Partial<IResearchTask> = {}): IResearchTask => {
  const mock = {
    userId: 'test-user-id',
    researchAgentId: 'test-research-agent-id',
    title: 'test-research-task-title',
    description: 'test-research-task-description',
    createdAt: new Date(),
    updatedAt: new Date(),
    url: 'https://example.com',
    urls: ['https://example.com'],
    canDiscoverLinks: true,
    type: ResearchTaskType.SCRAPE,
    discoveredLinks: [],
    status: ResearchTaskStatus.PENDING,
    content: '',
    executionType: ResearchTaskExecutionType.ON_DEMAND,
  };

  return Object.assign(mock, value) as IResearchTask;
};

/**
 * Mock a research agent
 * @param value - Partial<IResearchAgent> - The value to override the default data
 * @returns IResearchAgent - The mock research agent
 */
export const mockResearchAgent = (value: Partial<IResearchAgent> = {}): IResearchAgent => {
  const mock = {
    id: 'test-agent-id',
    userId: 'test-user-id',
    name: 'test-research-agent-name',
    description: 'test-research-agent-description',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return Object.assign(mock, value) as IResearchAgent;
};
