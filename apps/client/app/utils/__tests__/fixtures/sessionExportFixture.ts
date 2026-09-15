import { ISessionDocument, IChatHistoryItem } from '@bike4mind/common';

export const mockSession = {
  id: 'session-1',
  name: 'Test Session for Export',
  summary: 'A test session with various message types',
  tags: [
    { name: 'test', strength: 1 },
    { name: 'export', strength: 0.8 },
  ],
  firstCreated: new Date('2024-01-15T10:00:00Z'),
  lastUpdated: new Date('2024-01-15T12:30:00Z'),
} as unknown as ISessionDocument;

export const mockChatHistory: IChatHistoryItem[] = [
  {
    id: 'msg-1',
    timestamp: new Date('2024-01-15T10:00:00Z'),
    type: 'user',
    prompt: 'Hello, how can you help me today?',
    replies: ['I am an AI assistant. I can help you with various tasks including writing, coding, analysis, and more.'],
    promptMeta: {
      model: { name: 'gpt-4' },
      tokenUsage: { inputTokens: 10, outputTokens: 25 },
    },
  },
  {
    id: 'msg-2',
    timestamp: new Date('2024-01-15T10:05:00Z'),
    type: 'user',
    prompt: 'Can you write a function to calculate fibonacci numbers?',
    replies: [
      'Here is a recursive fibonacci function:\n\n```javascript\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\n```',
    ],
    promptMeta: {
      model: { name: 'gpt-4' },
      tokenUsage: { inputTokens: 15, outputTokens: 50 },
    },
    creditsUsed: 0.05,
  },
  {
    id: 'msg-3',
    timestamp: new Date('2024-01-15T10:10:00Z'),
    type: 'system',
    prompt: 'System context updated',
    replies: [],
  },
  {
    id: 'msg-4',
    timestamp: new Date('2024-01-15T10:15:00Z'),
    type: 'user',
    prompt: 'Thanks! That works great.',
    replies: ["You're welcome! Let me know if you need anything else."],
    promptMeta: {
      model: { name: 'gpt-4' },
      tokenUsage: { inputTokens: 8, outputTokens: 12 },
    },
  },
  // Deleted message should be skipped
  {
    id: 'msg-5',
    timestamp: new Date('2024-01-15T10:20:00Z'),
    type: 'user',
    prompt: 'This message was deleted',
    replies: ['This reply should not appear'],
    deletedAt: new Date('2024-01-15T10:21:00Z'),
  },
] as unknown as IChatHistoryItem[];

export const mockEmptySession = {
  id: 'session-empty',
  name: 'Empty Session',
  firstCreated: new Date('2024-01-15T10:00:00Z'),
  lastUpdated: new Date('2024-01-15T10:00:00Z'),
} as unknown as ISessionDocument;

export const mockEmptyChatHistory: IChatHistoryItem[] = [];
