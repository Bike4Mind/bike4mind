/**
 * Common mock objects for testing
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { vi } from 'vitest';
import type { Session, Message, CliConfig, AuthTokens } from '../storage/types';
import type { SessionStore } from '../storage/SessionStore';

/**
 * Creates a mock message object
 */
export function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-123',
    role: 'user',
    content: 'Test message',
    timestamp: '2026-01-15T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Creates a mock session object
 */
export function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-123',
    name: 'Test Session',
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    model: 'claude-opus-4',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Test message',
        timestamp: '2026-01-15T00:00:00.000Z',
      },
    ],
    metadata: {
      totalTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    ...overrides,
  };
}

/**
 * Creates a mock authentication tokens object
 */
export function createMockAuthTokens(overrides: Partial<AuthTokens> = {}): AuthTokens {
  return {
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    userId: 'user-123',
    ...overrides,
  };
}

/**
 * Creates a mock CLI configuration
 */
export function createMockConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    version: '1.0.0',
    userId: 'user-123',
    defaultModel: 'claude-opus-4',
    toolApiKeys: {},
    mcpServers: [],
    preferences: {
      maxTokens: 4096,
      temperature: 0.7,
      autoSave: true,
      theme: 'dark',
      exportFormat: 'markdown',
      maxIterations: null,
    },
    tools: {
      enabled: [],
      disabled: [],
      config: {},
    },
    ...overrides,
  };
}

/**
 * Creates a mock SessionStore
 */
export function createMockSessionStore(): SessionStore {
  const sessions = new Map<string, Session>();

  return {
    init: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockImplementation(async (session: Session) => {
      sessions.set(session.id, session);
    }),
    load: vi.fn().mockImplementation(async (id: string) => {
      return sessions.get(id) || null;
    }),
    list: vi.fn().mockImplementation(async () => {
      return Array.from(sessions.values()).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    }),
    delete: vi.fn().mockImplementation(async (id: string) => {
      sessions.delete(id);
    }),
    // Test helper to seed sessions
    _setSessions: (mockSessions: Session[]) => {
      sessions.clear();
      mockSessions.forEach(s => sessions.set(s.id, s));
    },
  } as any;
}

/**
 * Creates a mock LLM backend response
 */
export function createMockLlmResponse(content: string) {
  return {
    type: 'message',
    id: 'msg-123',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
    model: 'claude-opus-4',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    },
    stop_reason: 'end_turn',
  };
}

/**
 * Creates a mock LLM backend
 */
export function createMockLlmBackend() {
  return {
    sendMessage: vi.fn().mockResolvedValue(createMockLlmResponse('Mock response')),
    streamMessage: vi.fn(),
    countTokens: vi.fn().mockResolvedValue(100),
  };
}

/**
 * Creates a mock agent executor
 */
export function createMockAgent() {
  return {
    execute: vi.fn().mockResolvedValue({
      success: true,
      result: 'Mock agent result',
      steps: [],
    }),
    cancel: vi.fn(),
  };
}

/**
 * Mock filesystem operations
 */
export function createMockFileSystem() {
  const files = new Map<string, string>();

  return {
    promises: {
      readFile: vi.fn().mockImplementation(async (path: string) => {
        const content = files.get(path);
        if (!content) {
          const error: any = new Error(`ENOENT: no such file or directory, open '${path}'`);
          error.code = 'ENOENT';
          throw error;
        }
        return content;
      }),
      writeFile: vi.fn().mockImplementation(async (path: string, content: string) => {
        files.set(path, content);
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockImplementation(async () => {
        return Array.from(files.keys());
      }),
      unlink: vi.fn().mockImplementation(async (path: string) => {
        files.delete(path);
      }),
      stat: vi.fn().mockImplementation(async (path: string) => {
        if (!files.has(path)) {
          const error: any = new Error(`ENOENT: no such file or directory, stat '${path}'`);
          error.code = 'ENOENT';
          throw error;
        }
        return {
          isFile: () => true,
          isDirectory: () => false,
          mtime: new Date(),
        };
      }),
    },
    // Test helpers
    _setFile: (path: string, content: string) => {
      files.set(path, content);
    },
    _getFiles: () => files,
    _clear: () => {
      files.clear();
    },
  };
}

/**
 * Mock process.stdin for testing user input
 */
export function createMockStdin() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  return {
    setRawMode: vi.fn(),
    setEncoding: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(handler);
    }),
    // Test helper to emit events
    _emit: (event: string, data: unknown) => {
      const handlers = listeners.get(event) || [];
      handlers.forEach(handler => handler(data));
    },
    _clear: () => {
      listeners.clear();
    },
  };
}
