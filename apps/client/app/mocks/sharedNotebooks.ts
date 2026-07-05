import { ISessionDocument, Permission } from '@bike4mind/common';
import { v4 as uuidv4 } from 'uuid';

// Generate mock shared notebooks for the last 7 days
export function generateMockSharedNotebooks(currentUserId: string): ISessionDocument[] {
  const mockUsers = [
    { id: 'user-alice-123', name: 'Alice Johnson', email: 'alice@example.com' },
    { id: 'user-bob-456', name: 'Bob Smith', email: 'bob@example.com' },
    { id: 'user-charlie-789', name: 'Charlie Brown', email: 'charlie@example.com' },
    { id: 'user-diana-012', name: 'Diana Prince', email: 'diana@example.com' },
  ];

  const notebookTemplates = [
    {
      name: 'Project Planning: Q1 2025 Roadmap',
      tags: [
        { name: 'planning', strength: 0.9 },
        { name: 'roadmap', strength: 0.8 },
        { name: 'strategy', strength: 0.7 },
      ],
      summary: 'Strategic planning session for Q1 2025 product roadmap and key initiatives',
    },
    {
      name: 'Machine Learning: Neural Network Architecture',
      tags: [
        { name: 'machine-learning', strength: 0.95 },
        { name: 'neural-networks', strength: 0.85 },
        { name: 'deep-learning', strength: 0.8 },
      ],
      summary: 'Exploration of different neural network architectures for image classification',
    },
    {
      name: 'API Design: RESTful Best Practices',
      tags: [
        { name: 'api', strength: 0.9 },
        { name: 'rest', strength: 0.85 },
        { name: 'backend', strength: 0.7 },
      ],
      summary: 'Guidelines and patterns for designing scalable RESTful APIs',
    },
    {
      name: 'React Performance Optimization',
      tags: [
        { name: 'react', strength: 0.95 },
        { name: 'performance', strength: 0.9 },
        { name: 'frontend', strength: 0.8 },
      ],
      summary: 'Techniques for optimizing React application performance and reducing re-renders',
    },
    {
      name: 'Database Schema Migration Strategy',
      tags: [
        { name: 'database', strength: 0.9 },
        { name: 'migration', strength: 0.85 },
        { name: 'mongodb', strength: 0.8 },
      ],
      summary: 'Planning and executing database schema migrations with zero downtime',
    },
    {
      name: 'Team Retrospective: Sprint 42',
      tags: [
        { name: 'agile', strength: 0.85 },
        { name: 'retrospective', strength: 0.9 },
        { name: 'team', strength: 0.7 },
      ],
      summary: 'Sprint 42 retrospective notes and action items for continuous improvement',
    },
    {
      name: 'Customer Interview: User Pain Points',
      tags: [
        { name: 'research', strength: 0.9 },
        { name: 'user-experience', strength: 0.85 },
        { name: 'feedback', strength: 0.8 },
      ],
      summary: 'Analysis of customer interviews highlighting key pain points and feature requests',
    },
    {
      name: 'Python Data Analysis: Sales Metrics',
      tags: [
        { name: 'python', strength: 0.95 },
        { name: 'data-analysis', strength: 0.9 },
        { name: 'pandas', strength: 0.85 },
      ],
      summary: 'Quarterly sales data analysis using Python pandas and visualization libraries',
    },
    {
      name: 'Security Audit: OWASP Top 10',
      tags: [
        { name: 'security', strength: 0.95 },
        { name: 'audit', strength: 0.85 },
        { name: 'owasp', strength: 0.8 },
      ],
      summary: 'Security audit findings and remediation plan based on OWASP Top 10',
    },
    {
      name: 'DevOps: CI/CD Pipeline Setup',
      tags: [
        { name: 'devops', strength: 0.9 },
        { name: 'ci-cd', strength: 0.95 },
        { name: 'automation', strength: 0.8 },
      ],
      summary: 'Setting up continuous integration and deployment pipeline with GitHub Actions',
    },
    {
      name: 'Marketing Campaign Analysis',
      tags: [
        { name: 'marketing', strength: 0.9 },
        { name: 'analytics', strength: 0.85 },
        { name: 'campaign', strength: 0.8 },
      ],
      summary: 'Performance analysis of Q4 marketing campaigns and ROI calculations',
    },
    {
      name: 'Code Review: Authentication Module',
      tags: [
        { name: 'code-review', strength: 0.9 },
        { name: 'authentication', strength: 0.85 },
        { name: 'security', strength: 0.75 },
      ],
      summary: 'Detailed code review of the new JWT-based authentication implementation',
    },
  ];

  const notebooks: ISessionDocument[] = [];
  const now = new Date();

  // Generate notebooks for the last 7 days
  for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
    // Generate 2-4 notebooks per day
    const notebooksPerDay = Math.floor(Math.random() * 3) + 2;

    for (let i = 0; i < notebooksPerDay; i++) {
      const template = notebookTemplates[Math.floor(Math.random() * notebookTemplates.length)];
      const owner = mockUsers[Math.floor(Math.random() * mockUsers.length)];

      // Create a date for this notebook
      const notebookDate = new Date(now);
      notebookDate.setDate(notebookDate.getDate() - daysAgo);
      notebookDate.setHours(Math.floor(Math.random() * 24));
      notebookDate.setMinutes(Math.floor(Math.random() * 60));

      // Random chance of being favorited
      const isFavorited = Math.random() > 0.7;

      const firstCreated = new Date(notebookDate.getTime() - Math.random() * 7 * 24 * 60 * 60 * 1000); // Created up to 7 days before last update

      const notebook: ISessionDocument = {
        id: uuidv4(),
        name: template.name,
        userId: owner.id, // The owner of the notebook
        lastUpdated: notebookDate,
        firstCreated: firstCreated,
        createdAt: firstCreated, // IMongoDocument field
        updatedAt: notebookDate, // IMongoDocument field
        tags: isFavorited ? [...template.tags, { name: '<favorite>', strength: 1.0 }] : template.tags,
        summary: template.summary,
        summaryAt: notebookDate,
        summaryTrigger: 'manual',
        isAutoNamed: false,
        lastUsedModel: 'claude-3-5-sonnet-20241022',

        // Sharing properties
        isGlobalRead: false,
        isGlobalWrite: false,
        users: [
          {
            userId: currentUserId,
            permissions:
              Math.random() > 0.5
                ? [Permission.read, Permission.update] // 50% chance of write access
                : [Permission.read],
          },
          {
            userId: owner.id,
            permissions: [Permission.read, Permission.create, Permission.update, Permission.delete, Permission.share], // Owner has all permissions
          },
        ],
        groups: [],

        // Additional metadata that might be present
        language: 'en',
        knowledgeIds: [],
        artifactIds: [],
        toolIds: [],
        agentIds: [],
      };

      notebooks.push(notebook);
    }
  }

  // Sort by lastUpdated descending (most recent first)
  notebooks.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

  return notebooks;
}

// Mock API response structure
export function getMockSharedSessionsResponse(
  search: string = '',
  page: number = 1,
  limit: number = 10,
  currentUserId: string
) {
  const allNotebooks = generateMockSharedNotebooks(currentUserId);

  // Filter by search if provided
  const filteredNotebooks = search
    ? allNotebooks.filter(
        notebook =>
          notebook.name.toLowerCase().includes(search.toLowerCase()) ||
          notebook.tags?.some(tag => tag.name.toLowerCase().includes(search.toLowerCase()))
      )
    : allNotebooks;

  // Paginate
  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + limit;
  const paginatedNotebooks = filteredNotebooks.slice(startIndex, endIndex);

  return {
    data: paginatedNotebooks,
    hasMore: endIndex < filteredNotebooks.length,
    total: filteredNotebooks.length,
    page,
    limit,
  };
}
