import { describe, it, expect } from 'vitest';
import { buildCompactionPrompt, createCompactedSession } from './compaction.js';
import { HANDOFF_MARKER } from './handoff.js';
import type { Message, Session } from '../storage/types.js';

// Helper to create test messages
function createMessage(role: 'user' | 'assistant' | 'system', content: string, index: number): Message {
  return {
    id: `msg-${index}`,
    role,
    content,
    timestamp: new Date(Date.now() - (10 - index) * 60000).toISOString(),
  };
}

// Helper to create test session
function createSession(messages: Message[]): Session {
  return {
    id: 'test-session-id',
    name: 'Test Session',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: 'claude-sonnet',
    messages,
    metadata: {
      totalTokens: 1000,
      totalCost: 0.01,
      toolCallCount: 5,
    },
  };
}

describe('compaction', () => {
  describe('buildCompactionPrompt', () => {
    it('should preserve last 4 messages (2 exchanges) by default', () => {
      const messages: Message[] = [
        createMessage('user', 'First message', 0),
        createMessage('assistant', 'First response', 1),
        createMessage('user', 'Second message', 2),
        createMessage('assistant', 'Second response', 3),
        createMessage('user', 'Third message', 4),
        createMessage('assistant', 'Third response', 5),
        createMessage('user', 'Fourth message', 6),
        createMessage('assistant', 'Fourth response', 7),
      ];

      const result = buildCompactionPrompt(messages);

      expect(result.preservedMessages).toHaveLength(4);
      expect(result.preservedMessages[0].content).toBe('Third message');
      expect(result.preservedMessages[1].content).toBe('Third response');
      expect(result.preservedMessages[2].content).toBe('Fourth message');
      expect(result.preservedMessages[3].content).toBe('Fourth response');
    });

    it('should include summarization prompt with conversation to summarize', () => {
      const messages: Message[] = [
        createMessage('user', 'Old message one', 0),
        createMessage('assistant', 'Old response one', 1),
        createMessage('user', 'Old message two', 2),
        createMessage('assistant', 'Old response two', 3),
        createMessage('user', 'Recent message', 4),
        createMessage('assistant', 'Recent response', 5),
      ];

      const result = buildCompactionPrompt(messages);

      expect(result.prompt).toContain('summarizing a conversation');
      expect(result.prompt).toContain('Old message one');
      expect(result.prompt).toContain('Old response one');
      expect(result.prompt).not.toContain('Recent message');
    });

    it('should return empty prompt if not enough messages to summarize', () => {
      const messages: Message[] = [
        createMessage('user', 'First message', 0),
        createMessage('assistant', 'First response', 1),
        createMessage('user', 'Second message', 2),
        createMessage('assistant', 'Second response', 3),
      ];

      const result = buildCompactionPrompt(messages);

      expect(result.prompt).toBe('');
      expect(result.preservedMessages).toEqual(messages);
    });

    it('should include user instructions when provided', () => {
      const messages: Message[] = Array.from({ length: 8 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
      );

      const result = buildCompactionPrompt(messages, {
        userInstructions: 'Focus on the database changes',
      });

      expect(result.prompt).toContain('Focus on the database changes');
    });

    it('should include claudeMd instructions when provided', () => {
      const messages: Message[] = Array.from({ length: 8 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
      );

      const result = buildCompactionPrompt(messages, {
        claudeMdInstructions: 'Preserve React component names and file paths',
      });

      expect(result.prompt).toContain('Project-specific compaction instructions');
      expect(result.prompt).toContain('Preserve React component names and file paths');
    });

    it('should truncate very long messages in summary prompt', () => {
      const longContent = 'x'.repeat(3000);
      const messages: Message[] = [
        createMessage('user', longContent, 0),
        createMessage('assistant', 'Short response', 1),
        createMessage('user', 'Recent 1', 2),
        createMessage('assistant', 'Recent 2', 3),
        createMessage('user', 'Recent 3', 4),
        createMessage('assistant', 'Recent 4', 5),
      ];

      const result = buildCompactionPrompt(messages);

      expect(result.prompt).toContain('...[truncated]');
      expect(result.prompt.length).toBeLessThan(longContent.length);
    });

    it('should allow customizing preserveRecentExchanges', () => {
      const messages: Message[] = Array.from({ length: 10 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
      );

      const result = buildCompactionPrompt(messages, {
        preserveRecentExchanges: 3,
      });

      // 3 exchanges = 6 messages
      expect(result.preservedMessages).toHaveLength(6);
    });
  });

  describe('createCompactedSession', () => {
    it('should create new session with summary and preserved messages', () => {
      const originalSession = createSession([
        createMessage('user', 'Old message', 0),
        createMessage('assistant', 'Old response', 1),
        createMessage('user', 'Recent message', 2),
        createMessage('assistant', 'Recent response', 3),
      ]);

      const preservedMessages = [
        createMessage('user', 'Recent message', 2),
        createMessage('assistant', 'Recent response', 3),
      ];

      const summary = 'The user discussed old topics and received a response.';

      const newSession = createCompactedSession(originalSession, summary, preservedMessages);

      expect(newSession.id).not.toBe(originalSession.id);
      expect(newSession.name).toBe('Test Session (compacted)');
      expect(newSession.messages).toHaveLength(3); // 1 summary + 2 preserved
      expect(newSession.messages[0].role).toBe('user');
      expect(newSession.messages[0].content).toContain('[Previous conversation summary]');
      expect(newSession.messages[0].content).toContain(summary);
      expect(newSession.messages[1].content).toBe('Recent message');
      expect(newSession.messages[2].content).toBe('Recent response');
    });

    it('should preserve original session model', () => {
      const originalSession = createSession([]);
      originalSession.model = 'claude-opus-4-5';

      const newSession = createCompactedSession(originalSession, 'Summary', []);

      expect(newSession.model).toBe('claude-opus-4-5');
    });

    it('should set compactedFrom in metadata', () => {
      const originalSession = createSession([]);

      const newSession = createCompactedSession(originalSession, 'Summary', []);

      expect(newSession.metadata.compactedFrom).toBe('test-session-id');
    });

    it('should preserve summary through the user/assistant filter applied before agent.run', () => {
      // Regression: the summary used to be stored as role: 'system', which the
      // history slicer in index.tsx filters out before passing to the agent,
      // causing the LLM to lose all prior context after auto-compaction.
      const originalSession = createSession([
        createMessage('user', 'Old message', 0),
        createMessage('assistant', 'Old response', 1),
      ]);
      const preservedMessages = [
        createMessage('user', 'Recent message', 2),
        createMessage('assistant', 'Recent response', 3),
      ];

      const newSession = createCompactedSession(originalSession, 'Summary text', preservedMessages);

      const filtered = newSession.messages.filter(m => m.role === 'user' || m.role === 'assistant');
      const hasSummary = filtered.some(m => m.content.includes('[Previous conversation summary]'));
      expect(hasSummary).toBe(true);
    });

    it('should reset token and cost counters', () => {
      const originalSession = createSession([]);
      originalSession.metadata.totalTokens = 50000;
      originalSession.metadata.totalCost = 1.5;
      originalSession.metadata.toolCallCount = 100;

      const newSession = createCompactedSession(originalSession, 'Summary', []);

      expect(newSession.metadata.totalTokens).toBe(0);
      expect(newSession.metadata.totalCost).toBe(0);
      expect(newSession.metadata.toolCallCount).toBe(0);
    });

    it('should carry workflow state forward when present', () => {
      const originalSession = createSession([]);
      originalSession.metadata.workflow = {
        decisions: [
          {
            id: 'd1',
            timestamp: '2026-05-01T00:00:00.000Z',
            summary: 'Use Postgres',
            rationale: 'JSONB support',
          },
        ],
        blockers: [{ id: 'b1', createdAt: '2026-05-01T00:00:00.000Z', description: 'Missing key', status: 'open' }],
        handoff: {
          summary: 'Prior handoff',
          keyFindings: [],
          nextSteps: [],
          pendingDecisions: [],
          blockers: [],
          generatedAt: '2026-05-01T00:00:00.000Z',
        },
      };

      const newSession = createCompactedSession(originalSession, 'Summary', []);

      expect(newSession.metadata.workflow).toEqual(originalSession.metadata.workflow);
    });

    it('should prepend handoff as the first user message when present', () => {
      const originalSession = createSession([]);
      originalSession.metadata.workflow = {
        decisions: [],
        blockers: [],
        handoff: {
          summary: 'Investigated auth bug; root cause is missing token refresh.',
          keyFindings: ['middleware.ts:42 missing refresh'],
          nextSteps: ['Add refresh logic'],
          pendingDecisions: [],
          blockers: [],
          generatedAt: '2026-05-08T00:00:00.000Z',
        },
      };
      const preservedMessages = [
        { id: 'p1', role: 'user' as const, content: 'preserved user', timestamp: '2026-05-08T00:00:00.000Z' },
      ];

      const newSession = createCompactedSession(originalSession, 'summary text', preservedMessages);

      expect(newSession.messages[0].role).toBe('user');
      expect(newSession.messages[0].content).toContain(HANDOFF_MARKER);
      expect(newSession.messages[0].content).toContain('Investigated auth bug');
      expect(newSession.messages[1].role).toBe('user');
      expect(newSession.messages[1].content).toContain('[Previous conversation summary]');
      expect(newSession.messages[2].content).toBe('preserved user');
    });

    it('should omit the handoff message when no handoff is present', () => {
      const originalSession = createSession([]);
      originalSession.metadata.workflow = {
        decisions: [{ id: 'd1', timestamp: '2026-05-08T00:00:00.000Z', summary: 'x', rationale: 'y' }],
        blockers: [],
      };

      const newSession = createCompactedSession(originalSession, 'summary', []);

      expect(newSession.messages[0].role).toBe('user');
      expect(newSession.messages.some(m => m.role === 'system')).toBe(false);
    });

    it('should not set workflow when original has none', () => {
      const originalSession = createSession([]);

      const newSession = createCompactedSession(originalSession, 'Summary', []);

      expect(newSession.metadata.workflow).toBeUndefined();
    });

    it('should generate new timestamps', () => {
      const originalSession = createSession([]);
      originalSession.createdAt = '2020-01-01T00:00:00.000Z';
      originalSession.updatedAt = '2020-01-01T00:00:00.000Z';

      const before = Date.now();
      const newSession = createCompactedSession(originalSession, 'Summary', []);
      const after = Date.now();

      const createdAt = new Date(newSession.createdAt).getTime();
      const updatedAt = new Date(newSession.updatedAt).getTime();

      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(after);
      expect(updatedAt).toBeGreaterThanOrEqual(before);
      expect(updatedAt).toBeLessThanOrEqual(after);
    });
  });
});
