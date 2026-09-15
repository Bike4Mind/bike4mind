/**
 * Tests for SessionStore
 *
 * Tests session persistence, loading, listing, and deletion.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionStore } from './SessionStore';
import { promises as fs } from 'fs';
import { createMockSession } from '../test-utils/mocks';

// Mock the fs module
vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    unlink: vi.fn(),
  },
}));

// Mock os module to control homedir
vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

describe('SessionStore', () => {
  let sessionStore: SessionStore;
  const mockBasePath = '/test-sessions';

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore = new SessionStore(mockBasePath);
  });

  describe('constructor', () => {
    it('should use provided base path', () => {
      const store = new SessionStore('/custom/path');
      expect(store).toBeDefined();
    });

    it('should use default path when not provided', () => {
      const store = new SessionStore();
      expect(store).toBeDefined();
      // Default path would be ~/. bike4mind/sessions (mocked to /mock-home)
    });
  });

  describe('init', () => {
    it('should create storage directory', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await sessionStore.init();

      expect(fs.mkdir).toHaveBeenCalledWith(mockBasePath, { recursive: true });
    });

    it('should throw error if directory creation fails', async () => {
      const error = new Error('Permission denied');
      vi.mocked(fs.mkdir).mockRejectedValue(error);

      await expect(sessionStore.init()).rejects.toThrow('Permission denied');
    });
  });

  describe('save', () => {
    it('should save session to disk as JSON', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const session = createMockSession({
        id: 'test-session-1',
        name: 'Test Session',
      });

      await sessionStore.save(session);

      expect(fs.mkdir).toHaveBeenCalledWith(mockBasePath, { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test-sessions/test-session-1.json',
        JSON.stringify(session, null, 2),
        'utf-8'
      );
    });

    it('should call init before saving', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const session = createMockSession();

      await sessionStore.save(session);

      expect(fs.mkdir).toHaveBeenCalled();
    });

    it('should throw error if write fails', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Disk full'));

      const session = createMockSession();

      await expect(sessionStore.save(session)).rejects.toThrow('Disk full');
    });

    it('should format JSON with proper indentation', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const session = createMockSession();
      await sessionStore.save(session);

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const jsonContent = writeCall[1] as string;

      // Should be formatted with 2-space indentation
      expect(jsonContent).toContain('\n');
      expect(jsonContent.startsWith('{')).toBe(true);
    });

    it('should throw error when saving session with no messages', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const emptySession = createMockSession({ messages: [] });

      await expect(sessionStore.save(emptySession)).rejects.toThrow('Cannot save session with no messages');
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('load', () => {
    it('should load session from disk', async () => {
      const session = createMockSession({
        id: 'test-id',
        name: 'Loaded Session',
      });

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(session));

      const loaded = await sessionStore.load('test-id');

      expect(fs.readFile).toHaveBeenCalledWith('/test-sessions/test-id.json', 'utf-8');
      expect(loaded).toEqual(session);
    });

    it('should return null for non-existent session', async () => {
      const error: any = new Error('File not found');
      error.code = 'ENOENT';
      vi.mocked(fs.readFile).mockRejectedValue(error);

      const loaded = await sessionStore.load('non-existent');

      expect(loaded).toBeNull();
    });

    it('should add IDs to messages without IDs (backward compatibility)', async () => {
      const sessionWithoutMessageIds = {
        ...createMockSession(),
        messages: [
          {
            role: 'user',
            content: 'Hello',
            timestamp: '2026-01-15T00:00:00.000Z',
            // No id field
          } as any,
        ],
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sessionWithoutMessageIds));

      const loaded = await sessionStore.load('test-id');

      expect(loaded!.messages[0]).toHaveProperty('id');
      expect(typeof loaded!.messages[0].id).toBe('string');
      expect(loaded!.messages[0].id.length).toBeGreaterThan(0);
    });

    it('should preserve existing message IDs', async () => {
      const session = createMockSession({
        messages: [
          {
            id: 'existing-id',
            role: 'user',
            content: 'Hello',
            timestamp: '2026-01-15T00:00:00.000Z',
          },
        ],
      });

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(session));

      const loaded = await sessionStore.load('test-id');

      expect(loaded!.messages[0].id).toBe('existing-id');
    });

    it('should throw error for corrupted JSON', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('invalid json {{{');

      await expect(sessionStore.load('test-id')).rejects.toThrow();
    });

    it('should throw error for other filesystem errors', async () => {
      const error: any = new Error('Permission denied');
      error.code = 'EACCES';
      vi.mocked(fs.readFile).mockRejectedValue(error);

      await expect(sessionStore.load('test-id')).rejects.toThrow('Permission denied');
    });
  });

  describe('loadByName', () => {
    it('should load session by name', async () => {
      const session1 = createMockSession({
        id: 'id-1',
        name: 'Session A',
      });
      const session2 = createMockSession({
        id: 'id-2',
        name: 'Session B',
      });

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(['id-1.json', 'id-2.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(session1))
        .mockResolvedValueOnce(JSON.stringify(session2));

      const loaded = await sessionStore.loadByName('Session B');

      expect(loaded).toEqual(session2);
    });

    it('should return null if session not found', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);

      const loaded = await sessionStore.loadByName('Non-existent');

      expect(loaded).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all sessions sorted by updatedAt', async () => {
      const session1 = createMockSession({
        id: 'id-1',
        name: 'Old Session',
        updatedAt: '2026-01-14T00:00:00.000Z',
      });
      const session2 = createMockSession({
        id: 'id-2',
        name: 'New Session',
        updatedAt: '2026-01-15T00:00:00.000Z',
      });
      const session3 = createMockSession({
        id: 'id-3',
        name: 'Middle Session',
        updatedAt: '2026-01-14T12:00:00.000Z',
      });

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(['id-1.json', 'id-2.json', 'id-3.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(session1))
        .mockResolvedValueOnce(JSON.stringify(session2))
        .mockResolvedValueOnce(JSON.stringify(session3));

      const sessions = await sessionStore.list();

      expect(sessions).toHaveLength(3);
      // Should be sorted newest first
      expect(sessions[0].name).toBe('New Session');
      expect(sessions[1].name).toBe('Middle Session');
      expect(sessions[2].name).toBe('Old Session');
    });

    it('should filter out non-JSON files', async () => {
      const session = createMockSession();

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(['session-1.json', 'temp.txt', 'backup.bak', '.DS_Store'] as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(session));

      const sessions = await sessionStore.list();

      expect(sessions).toHaveLength(1);
      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should return empty array if directory is empty', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);

      const sessions = await sessionStore.list();

      expect(sessions).toEqual([]);
    });

    it('should return empty array on error', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Read error'));

      const sessions = await sessionStore.list();

      expect(sessions).toEqual([]);
    });

    it('should add IDs to messages in listed sessions', async () => {
      const sessionWithoutIds = {
        ...createMockSession(),
        messages: [
          {
            role: 'user',
            content: 'Test',
            timestamp: '2026-01-15T00:00:00.000Z',
          } as any,
        ],
      };

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(['test.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(sessionWithoutIds));

      const sessions = await sessionStore.list();

      expect(sessions[0].messages[0]).toHaveProperty('id');
    });

    it('should limit the number of sessions returned when limit is specified', async () => {
      // Create 5 sessions with different timestamps
      const sessions = Array.from({ length: 5 }, (_, i) =>
        createMockSession({
          id: `id-${i}`,
          name: `Session ${i}`,
          updatedAt: new Date(2026, 0, i + 1).toISOString(),
        })
      );

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(sessions.map((_, i) => `id-${i}.json`) as any);
      sessions.forEach(session => {
        vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(session));
      });

      const result = await sessionStore.list(3);

      expect(result).toHaveLength(3);
      // Should return the 3 most recent sessions
      expect(result[0].name).toBe('Session 4');
      expect(result[1].name).toBe('Session 3');
      expect(result[2].name).toBe('Session 2');
    });

    it('should return all sessions when limit is not specified', async () => {
      const sessions = Array.from({ length: 5 }, (_, i) =>
        createMockSession({
          id: `id-${i}`,
          name: `Session ${i}`,
        })
      );

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(sessions.map((_, i) => `id-${i}.json`) as any);
      sessions.forEach(session => {
        vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(session));
      });

      const result = await sessionStore.list();

      expect(result).toHaveLength(5);
    });

    it('should filter out and delete sessions with no messages', async () => {
      const validSession = createMockSession({
        id: 'valid',
        name: 'Valid Session',
      });
      const emptySession1 = createMockSession({
        id: 'empty1',
        name: 'Empty Session 1',
        messages: [],
      });
      const emptySession2 = createMockSession({
        id: 'empty2',
        name: 'Empty Session 2',
        messages: [],
      });

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(['valid.json', 'empty1.json', 'empty2.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(validSession))
        .mockResolvedValueOnce(JSON.stringify(emptySession1))
        .mockResolvedValueOnce(JSON.stringify(emptySession2));
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const result = await sessionStore.list();

      // Should only return the valid session
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('valid');

      // Should have deleted the empty sessions
      expect(fs.unlink).toHaveBeenCalledTimes(2);
      expect(fs.unlink).toHaveBeenCalledWith('/test-sessions/empty1.json');
      expect(fs.unlink).toHaveBeenCalledWith('/test-sessions/empty2.json');
    });

    it('should continue if deleting empty session fails', async () => {
      const validSession = createMockSession({
        id: 'valid',
        name: 'Valid Session',
      });
      const emptySession = createMockSession({
        id: 'empty',
        name: 'Empty Session',
        messages: [],
      });

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(['valid.json', 'empty.json'] as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(validSession))
        .mockResolvedValueOnce(JSON.stringify(emptySession));
      vi.mocked(fs.unlink).mockRejectedValue(new Error('Delete failed'));

      const result = await sessionStore.list();

      // Should still return valid sessions even if delete fails
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('valid');
    });
  });

  describe('delete', () => {
    it('should delete session file', async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const result = await sessionStore.delete('test-id');

      expect(fs.unlink).toHaveBeenCalledWith('/test-sessions/test-id.json');
      expect(result).toBe(true);
    });

    it('should return false for non-existent session', async () => {
      const error: any = new Error('File not found');
      error.code = 'ENOENT';
      vi.mocked(fs.unlink).mockRejectedValue(error);

      const result = await sessionStore.delete('non-existent');

      expect(result).toBe(false);
    });

    it('should throw error for other filesystem errors', async () => {
      const error: any = new Error('Permission denied');
      error.code = 'EACCES';
      vi.mocked(fs.unlink).mockRejectedValue(error);

      await expect(sessionStore.delete('test-id')).rejects.toThrow('Permission denied');
    });
  });

  describe('deleteByName', () => {
    it('should delete session by name', async () => {
      const session = createMockSession({
        id: 'test-id',
        name: 'To Delete',
      });

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(['test-id.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(session));
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const result = await sessionStore.deleteByName('To Delete');

      expect(fs.unlink).toHaveBeenCalledWith('/test-sessions/test-id.json');
      expect(result).toBe(true);
    });

    it('should return false if session not found', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);

      const result = await sessionStore.deleteByName('Non-existent');

      expect(result).toBe(false);
      expect(fs.unlink).not.toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('should rename session and update timestamp', async () => {
      const originalSession = createMockSession({
        id: 'test-id',
        name: 'Old Name',
        updatedAt: '2026-01-14T00:00:00.000Z',
      });

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(originalSession));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await sessionStore.rename('test-id', 'New Name');

      expect(result).toBe(true);
      expect(fs.writeFile).toHaveBeenCalled();

      const savedData = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      const savedSession = JSON.parse(savedData);

      expect(savedSession.name).toBe('New Name');
      expect(savedSession.updatedAt).not.toBe('2026-01-14T00:00:00.000Z');
      expect(new Date(savedSession.updatedAt).getTime()).toBeGreaterThan(
        new Date('2026-01-14T00:00:00.000Z').getTime()
      );
    });

    it('should return false for non-existent session', async () => {
      const error: any = new Error('File not found');
      error.code = 'ENOENT';
      vi.mocked(fs.readFile).mockRejectedValue(error);

      const result = await sessionStore.rename('non-existent', 'New Name');

      expect(result).toBe(false);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should preserve all session data except name and updatedAt', async () => {
      const session = createMockSession({
        id: 'test-id',
        name: 'Old Name',
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Hello',
            timestamp: '2026-01-15T00:00:00.000Z',
          },
        ],
        metadata: {
          totalTokens: 100,
          totalCost: 0.01,
          toolCallCount: 5,
        },
      });

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(session));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await sessionStore.rename('test-id', 'New Name');

      const savedData = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      const savedSession = JSON.parse(savedData);

      expect(savedSession.messages).toEqual(session.messages);
      expect(savedSession.metadata).toEqual(session.metadata);
      expect(savedSession.model).toBe(session.model);
      expect(savedSession.createdAt).toBe(session.createdAt);
    });
  });

  describe('integration scenarios', () => {
    it('should handle save-load-delete workflow', async () => {
      const session = createMockSession({
        id: 'workflow-test',
        name: 'Workflow Session',
      });

      // Save
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      await sessionStore.save(session);

      // Load
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(session));
      const loaded = await sessionStore.load('workflow-test');
      expect(loaded).toEqual(session);

      // Delete
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      const deleted = await sessionStore.delete('workflow-test');
      expect(deleted).toBe(true);
    });

    it('should handle multiple concurrent saves', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const sessions = [
        createMockSession({ id: '1', name: 'Session 1' }),
        createMockSession({ id: '2', name: 'Session 2' }),
        createMockSession({ id: '3', name: 'Session 3' }),
      ];

      await Promise.all(sessions.map(s => sessionStore.save(s)));

      expect(fs.writeFile).toHaveBeenCalledTimes(3);
    });

    it('should handle session with large message history', async () => {
      const largeSession = createMockSession({
        messages: Array.from({ length: 1000 }, (_, i) => ({
          id: `msg-${i}`,
          role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `Message ${i}`,
          timestamp: new Date().toISOString(),
        })),
      });

      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await sessionStore.save(largeSession);

      expect(fs.writeFile).toHaveBeenCalled();
      const savedData = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(savedData);
      expect(parsed.messages).toHaveLength(1000);
    });
  });
});
