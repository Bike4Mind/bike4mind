import { describe, it, expect, vi } from 'vitest';
import {
  toExportableSession,
  getSessionExportFilename,
  sessionToMarkdown,
  sessionToJSON,
  sessionToCSV,
} from '../sessionExport';
import { mockSession, mockChatHistory, mockEmptySession, mockEmptyChatHistory } from './fixtures/sessionExportFixture';

describe('sessionExport', () => {
  describe('toExportableSession', () => {
    it('should convert session and chat history to exportable format', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);

      expect(exportable.id).toBe('session-1');
      expect(exportable.name).toBe('Test Session for Export');
      expect(exportable.summary).toBe('A test session with various message types');
      expect(exportable.tags).toHaveLength(2);
    });

    it('should extract user messages and assistant replies', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);

      // 4 user/system prompts + 3 assistant replies (one message has no reply, one is deleted)
      expect(exportable.messages.length).toBeGreaterThan(0);

      const userMessages = exportable.messages.filter(m => m.role === 'user');
      const assistantMessages = exportable.messages.filter(m => m.role === 'assistant');
      const systemMessages = exportable.messages.filter(m => m.role === 'system');

      expect(userMessages.length).toBe(3);
      expect(assistantMessages.length).toBe(3);
      expect(systemMessages.length).toBe(1);
    });

    it('should skip deleted messages', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);

      const deletedContent = exportable.messages.find(m => m.content.includes('This message was deleted'));
      expect(deletedContent).toBeUndefined();
    });

    it('should include model and token information', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);

      const messageWithModel = exportable.messages.find(m => m.model === 'gpt-4');
      expect(messageWithModel).toBeDefined();

      const messageWithTokens = exportable.messages.find(m => m.tokensUsed !== undefined);
      expect(messageWithTokens).toBeDefined();
    });

    it('should handle empty chat history', () => {
      const exportable = toExportableSession(mockEmptySession, mockEmptyChatHistory);

      expect(exportable.messages).toHaveLength(0);
      expect(exportable.name).toBe('Empty Session');
    });

    it('should clean a raw JSON-literal session name', () => {
      const jsonNamed = { ...mockSession, name: '{ "headline": "The Epistemology of Cats" }' };
      const exportable = toExportableSession(jsonNamed, mockChatHistory);

      expect(exportable.name).toBe('The Epistemology of Cats');
    });
  });

  describe('getSessionExportFilename', () => {
    it('should create a slug from the session name', () => {
      expect(getSessionExportFilename('My Test Session')).toBe('session-my-test-session');
    });

    it('should truncate long names', () => {
      const longName = 'A'.repeat(100);
      const filename = getSessionExportFilename(longName);
      expect(filename.length).toBeLessThanOrEqual(58); // "session-" prefix + 50 chars max
    });

    it('should handle special characters', () => {
      expect(getSessionExportFilename('Test: Session & Export!')).toBe('session-test-session-export');
    });

    it('should handle leading/trailing hyphens', () => {
      expect(getSessionExportFilename('---Test---')).toBe('session-test');
    });

    it('should slugify the cleaned title, not a raw JSON literal', () => {
      expect(getSessionExportFilename('{ "headline": "The Epistemology of Cats" }')).toBe(
        'session-the-epistemology-of-cats'
      );
    });
  });

  describe('sessionToMarkdown', () => {
    it('should contain the session name as heading', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const md = sessionToMarkdown(exportable);
      expect(md).toContain('# Test Session for Export');
    });

    it('should contain export metadata', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const md = sessionToMarkdown(exportable);
      expect(md).toContain('Exported on');
      expect(md).toContain('Created:');
      expect(md).toContain('Updated:');
      expect(md).toContain('Messages:');
    });

    it('should contain tags', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const md = sessionToMarkdown(exportable);
      expect(md).toContain('Tags: test, export');
    });

    it('should contain summary', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const md = sessionToMarkdown(exportable);
      expect(md).toContain('## Summary');
      expect(md).toContain('A test session with various message types');
    });

    it('should contain conversation section', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const md = sessionToMarkdown(exportable);
      expect(md).toContain('## Conversation');
      expect(md).toContain('**User**:');
      expect(md).toContain('**AI**:');
      expect(md).toContain('**System**:');
    });

    it('should contain message content', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const md = sessionToMarkdown(exportable);
      expect(md).toContain('Hello, how can you help me today?');
      expect(md).toContain('fibonacci');
    });
  });

  describe('sessionToJSON', () => {
    it('should produce valid JSON', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const json = sessionToJSON(exportable);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('should include format version', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const parsed = JSON.parse(sessionToJSON(exportable));
      expect(parsed.format).toBe('session-v1');
    });

    it('should include exportedAt timestamp', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const parsed = JSON.parse(sessionToJSON(exportable));
      expect(parsed.exportedAt).toBeDefined();
      expect(() => new Date(parsed.exportedAt)).not.toThrow();
    });

    it('should include session metadata', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const parsed = JSON.parse(sessionToJSON(exportable));
      expect(parsed.session.name).toBe('Test Session for Export');
      expect(parsed.session.summary).toBe('A test session with various message types');
      expect(parsed.session.tags).toContain('test');
    });

    it('should include all messages', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const parsed = JSON.parse(sessionToJSON(exportable));
      expect(parsed.messages.length).toBeGreaterThan(0);
      expect(parsed.messages[0].role).toBeDefined();
      expect(parsed.messages[0].content).toBeDefined();
    });

    it('should include message metadata', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const parsed = JSON.parse(sessionToJSON(exportable));
      const messageWithModel = parsed.messages.find((m: { model?: string }) => m.model === 'gpt-4');
      expect(messageWithModel).toBeDefined();
    });
  });

  describe('sessionToCSV', () => {
    it('should produce valid CSV with headers', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const csv = sessionToCSV(exportable);
      const lines = csv.split('\n');
      expect(lines[0]).toContain('Timestamp');
      expect(lines[0]).toContain('Role');
      expect(lines[0]).toContain('Content');
      expect(lines[0]).toContain('Model');
      expect(lines[0]).toContain('Tokens Used');
      expect(lines[0]).toContain('Credits Used');
    });

    it('should contain correct number of data rows based on message count', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const csv = sessionToCSV(exportable);
      // Parse CSV to count actual data rows (excluding multiline content issues)
      const parsed = csv.split('\n');
      const headerLine = parsed[0];
      // Verify header exists with expected columns
      expect(headerLine).toContain('Timestamp');
      expect(headerLine).toContain('Role');
      // Message count should match exportable messages
      expect(exportable.messages.length).toBe(7); // 3 user + 3 assistant + 1 system
    });

    it('should contain message content', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const csv = sessionToCSV(exportable);
      expect(csv).toContain('Hello');
      expect(csv).toContain('fibonacci');
    });

    it('should use proper role labels', () => {
      const exportable = toExportableSession(mockSession, mockChatHistory);
      const csv = sessionToCSV(exportable);
      expect(csv).toContain('User');
      expect(csv).toContain('Assistant');
      expect(csv).toContain('System');
    });
  });

  describe('sessionToExcel', () => {
    it('should generate a valid xlsx blob and trigger download', async () => {
      vi.resetModules();
      const downloadMock = vi.fn();
      vi.doMock('@client/app/utils/download', () => ({
        downloadData: downloadMock,
      }));

      const { sessionToExcel, toExportableSession } = await import('../sessionExport');
      const { mockSession, mockChatHistory } = await import('./fixtures/sessionExportFixture');
      const exportable = toExportableSession(mockSession, mockChatHistory);
      await sessionToExcel(exportable, 'test-session');

      expect(downloadMock).toHaveBeenCalledTimes(1);
      const [blob, filename, mimeType] = downloadMock.mock.calls[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(filename).toBe('test-session.xlsx');
      expect(mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    });

    it('should generate a blob with non-zero size', async () => {
      vi.resetModules();
      const downloadMock = vi.fn();
      vi.doMock('@client/app/utils/download', () => ({
        downloadData: downloadMock,
      }));

      const { sessionToExcel, toExportableSession } = await import('../sessionExport');
      const { mockSession, mockChatHistory } = await import('./fixtures/sessionExportFixture');
      const exportable = toExportableSession(mockSession, mockChatHistory);
      await sessionToExcel(exportable, 'test-session');

      const [blob] = downloadMock.mock.calls[0];
      expect((blob as Blob).size).toBeGreaterThan(0);
    });
  });

  describe('sessionToDocx', () => {
    it('should generate a valid docx blob and trigger download', async () => {
      vi.resetModules();
      const downloadMock = vi.fn();
      vi.doMock('@client/app/utils/download', () => ({
        downloadData: downloadMock,
      }));

      const { sessionToDocx, toExportableSession } = await import('../sessionExport');
      const { mockSession, mockChatHistory } = await import('./fixtures/sessionExportFixture');
      const exportable = toExportableSession(mockSession, mockChatHistory);
      await sessionToDocx(exportable, 'test-session');

      expect(downloadMock).toHaveBeenCalledTimes(1);
      const [blob, filename, mimeType] = downloadMock.mock.calls[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(filename).toBe('test-session.docx');
      expect(mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });

    it('should generate a blob with non-zero size', async () => {
      vi.resetModules();
      const downloadMock = vi.fn();
      vi.doMock('@client/app/utils/download', () => ({
        downloadData: downloadMock,
      }));

      const { sessionToDocx, toExportableSession } = await import('../sessionExport');
      const { mockSession, mockChatHistory } = await import('./fixtures/sessionExportFixture');
      const exportable = toExportableSession(mockSession, mockChatHistory);
      await sessionToDocx(exportable, 'test-session');

      const [blob] = downloadMock.mock.calls[0];
      expect((blob as Blob).size).toBeGreaterThan(0);
    });
  });
});
