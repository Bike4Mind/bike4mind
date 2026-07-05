import { IProjectDocument } from '@bike4mind/common';

// Mock projects for testing
export const generateMockProjects = (userId: string, count: number = 3): IProjectDocument[] => {
  const now = new Date();
  const projects: IProjectDocument[] = [];

  const projectNames = [
    'Q4 Marketing Strategy',
    'Product Roadmap 2025',
    'Customer Research Initiative',
    'Design System Revamp',
    'API Documentation',
    'Performance Optimization Sprint',
  ];

  const descriptions = [
    'Comprehensive marketing plan for the upcoming quarter including digital campaigns and brand positioning',
    'Strategic product development timeline with feature prioritization and resource allocation',
    'User interviews and market analysis to identify key pain points and opportunities',
    'Modernizing our design components for better consistency and developer experience',
    'Complete API reference documentation with examples and best practices',
    'Focused effort on improving application performance and reducing load times',
  ];

  for (let i = 0; i < count && i < projectNames.length; i++) {
    const createdDaysAgo = Math.floor(Math.random() * 7);
    const createdAt = new Date(now);
    createdAt.setDate(createdAt.getDate() - createdDaysAgo);
    createdAt.setHours(Math.floor(Math.random() * 24));
    createdAt.setMinutes(Math.floor(Math.random() * 60));

    const updatedAt = new Date(createdAt);
    updatedAt.setHours(updatedAt.getHours() + Math.floor(Math.random() * 48));

    const project: any = {
      _id: `mock-project-${i + 1}`,
      id: `mock-project-${i + 1}`,
      name: projectNames[i],
      description: descriptions[i],
      userId,
      sessionIds: [],
      fileIds: [],
      systemPrompts: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      groups: [],
      users: [],
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      tenantId: `tenant-${userId}`,
      orgId: `org-${userId}`,
    };

    projects.push(project as IProjectDocument);
  }

  return projects.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};
