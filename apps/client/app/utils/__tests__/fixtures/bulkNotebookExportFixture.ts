import { BulkExportData } from '../../bulkNotebookExport';

export const mockBulkExportData: BulkExportData = {
  exportVersion: '1.0',
  exportedAt: '2024-01-15T12:00:00Z',
  notebooks: [
    {
      id: 'notebook-1',
      name: 'Project Planning Session',
      firstCreated: '2024-01-10T09:00:00Z',
      lastUpdated: '2024-01-15T11:30:00Z',
      summary: 'Discussion about project architecture and timeline',
      tags: [
        { name: 'planning', strength: 1 },
        { name: 'architecture', strength: 0.8 },
      ],
      chatHistory: [
        {
          id: 'msg-1',
          timestamp: '2024-01-10T09:00:00Z',
          type: 'user',
          prompt: 'Let me outline the project requirements',
          replies: ['I understand. Please share the requirements and I will help organize them.'],
          promptMeta: {
            model: { name: 'gpt-4' },
            tokenUsage: { inputTokens: 10, outputTokens: 15 },
          },
        },
        {
          id: 'msg-2',
          timestamp: '2024-01-10T09:05:00Z',
          type: 'user',
          prompt: 'We need a REST API with authentication',
          replies: [
            'For a REST API with authentication, I recommend:\n1. JWT-based auth\n2. OAuth 2.0 for third-party\n3. Rate limiting',
          ],
          promptMeta: {
            model: { name: 'gpt-4' },
            tokenUsage: { inputTokens: 12, outputTokens: 35 },
          },
        },
      ],
    },
    {
      id: 'notebook-2',
      name: 'Code Review Session',
      firstCreated: '2024-01-12T14:00:00Z',
      lastUpdated: '2024-01-12T16:00:00Z',
      language: 'typescript',
      chatHistory: [
        {
          id: 'msg-3',
          timestamp: '2024-01-12T14:00:00Z',
          type: 'user',
          prompt: 'Please review this TypeScript code',
          replies: ['I will review the code for best practices, type safety, and potential issues.'],
          promptMeta: {
            model: { name: 'claude-3' },
            tokenUsage: { inputTokens: 8, outputTokens: 18 },
          },
        },
        {
          id: 'msg-4',
          timestamp: '2024-01-12T14:10:00Z',
          type: 'system',
          prompt: 'Code context loaded',
          replies: [],
        },
        {
          id: 'msg-5',
          timestamp: '2024-01-12T14:15:00Z',
          type: 'user',
          prompt: 'What about error handling?',
          replies: [
            'The error handling could be improved:\n- Add try/catch blocks\n- Use custom error classes\n- Implement proper logging',
          ],
          promptMeta: {
            model: { name: 'claude-3' },
            tokenUsage: { inputTokens: 6, outputTokens: 28 },
          },
        },
      ],
    },
    {
      id: 'notebook-3',
      name: 'Empty Notebook',
      firstCreated: '2024-01-14T10:00:00Z',
      lastUpdated: '2024-01-14T10:00:00Z',
      chatHistory: [],
    },
  ],
};

export const mockEmptyBulkExportData: BulkExportData = {
  exportVersion: '1.0',
  exportedAt: '2024-01-15T12:00:00Z',
  notebooks: [],
};

export const mockSingleNotebookExportData: BulkExportData = {
  exportVersion: '1.0',
  exportedAt: '2024-01-15T12:00:00Z',
  notebooks: [
    {
      id: 'notebook-single',
      name: 'Single Notebook Test',
      firstCreated: '2024-01-15T10:00:00Z',
      lastUpdated: '2024-01-15T11:00:00Z',
      chatHistory: [
        {
          id: 'msg-single',
          timestamp: '2024-01-15T10:00:00Z',
          type: 'user',
          prompt: 'Hello world',
          replies: ['Hello! How can I help you today?'],
        },
      ],
    },
  ],
};
