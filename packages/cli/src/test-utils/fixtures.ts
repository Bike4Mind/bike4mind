/**
 * Test data fixtures
 * Reusable test data for consistent testing
 */

/**
 * Sample messages for testing
 */
export const fixtures = {
  messages: {
    userMessage: {
      id: 'msg-user-1',
      role: 'user' as const,
      content: 'Hello, how can I create a React component?',
      timestamp: '2026-01-15T10:00:00.000Z',
    },
    assistantMessage: {
      id: 'msg-assistant-1',
      role: 'assistant' as const,
      content: 'I can help you create a React component. Here is an example...',
      timestamp: '2026-01-15T10:00:05.000Z',
      metadata: {
        tokenUsage: {
          prompt: 100,
          completion: 50,
          total: 150,
        },
        cost: 0.001,
        model: 'claude-opus-4',
      },
    },
    systemMessage: {
      id: 'msg-system-1',
      role: 'system' as const,
      content: 'You are a helpful assistant.',
      timestamp: '2026-01-15T09:59:00.000Z',
    },
    messageWithSteps: {
      id: 'msg-with-steps-1',
      role: 'assistant' as const,
      content: 'I searched the codebase and found the following...',
      timestamp: '2026-01-15T10:05:00.000Z',
      metadata: {
        steps: [
          {
            type: 'tool_use',
            tool: 'grep',
            input: { pattern: 'React.Component' },
            output: 'Found 10 matches',
            timestamp: '2026-01-15T10:05:01.000Z',
          },
        ],
      },
    },
  },

  sessions: {
    emptySession: {
      id: 'session-empty',
      name: 'Empty Session',
      createdAt: '2026-01-15T09:00:00.000Z',
      updatedAt: '2026-01-15T09:00:00.000Z',
      model: 'claude-opus-4',
      messages: [],
      metadata: {
        totalTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    },
    activeSession: {
      id: 'session-active',
      name: 'React Component Help',
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:05:00.000Z',
      model: 'claude-opus-4',
      messages: [
        {
          id: 'msg-user-1',
          role: 'user' as const,
          content: 'Hello, how can I create a React component?',
          timestamp: '2026-01-15T10:00:00.000Z',
        },
        {
          id: 'msg-assistant-1',
          role: 'assistant' as const,
          content: 'I can help you create a React component.',
          timestamp: '2026-01-15T10:00:05.000Z',
          metadata: {
            tokenUsage: {
              prompt: 100,
              completion: 50,
              total: 150,
            },
            cost: 0.001,
          },
        },
      ],
      metadata: {
        totalTokens: 150,
        totalCost: 0.001,
        toolCallCount: 0,
      },
    },
    longSession: {
      id: 'session-long',
      name: 'Long Conversation',
      createdAt: '2026-01-14T10:00:00.000Z',
      updatedAt: '2026-01-15T11:00:00.000Z',
      model: 'claude-opus-4',
      messages: Array.from({ length: 50 }, (_, i) => ({
        id: `msg-${i}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `Message ${i + 1}`,
        timestamp: new Date(Date.now() - (50 - i) * 60000).toISOString(),
      })),
      metadata: {
        totalTokens: 10000,
        totalCost: 0.05,
        toolCallCount: 15,
      },
    },
  },

  configs: {
    defaultConfig: {
      version: '1.0.0',
      userId: 'test-user-123',
      defaultModel: 'claude-opus-4',
      toolApiKeys: {},
      mcpServers: [],
      preferences: {
        maxTokens: 4096,
        temperature: 0.7,
        autoSave: true,
        theme: 'dark' as const,
        exportFormat: 'markdown' as const,
        maxIterations: null,
      },
      tools: {
        enabled: ['read', 'write', 'bash'],
        disabled: [],
        config: {},
      },
      trustedTools: ['read'],
    },
    authenticatedConfig: {
      version: '1.0.0',
      userId: 'test-user-123',
      auth: {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        userId: 'test-user-123',
      },
      defaultModel: 'claude-opus-4',
      toolApiKeys: {
        openweather: 'test-weather-key',
        serper: 'test-serper-key',
      },
      mcpServers: [
        {
          name: 'test-mcp-server',
          command: 'node',
          args: ['server.js'],
          env: { API_KEY: 'test-key' },
          enabled: true,
        },
      ],
      preferences: {
        maxTokens: 8192,
        temperature: 0.8,
        autoSave: false,
        theme: 'light' as const,
        exportFormat: 'json' as const,
        maxIterations: 10,
      },
      tools: {
        enabled: ['read', 'write', 'bash', 'grep'],
        disabled: ['delete'],
        config: {
          bash: { timeout: 5000 },
        },
      },
      trustedTools: ['read', 'grep'],
    },
  },

  errors: {
    fileNotFound: {
      code: 'ENOENT',
      message: 'ENOENT: no such file or directory',
    },
    permissionDenied: {
      code: 'EACCES',
      message: 'EACCES: permission denied',
    },
    invalidJson: {
      name: 'SyntaxError',
      message: 'Unexpected token in JSON at position 0',
    },
  },

  paths: {
    homedir: '/Users/testuser',
    sessionDir: '/Users/testuser/.bike4mind/sessions',
    configFile: '/Users/testuser/.bike4mind/config.json',
    projectRoot: '/Users/testuser/projects/my-project',
    projectConfig: '/Users/testuser/projects/my-project/.bike4mind/config.json',
  },

  timestamps: {
    now: '2026-01-15T12:00:00.000Z',
    past: '2026-01-14T12:00:00.000Z',
    future: '2026-01-16T12:00:00.000Z',
  },

  permissions: {
    allowedPatterns: ['*.ts', 'src/**/*.tsx', 'package.json', '/usr/local/bin/*'],
    deniedPatterns: ['/etc/passwd', '~/.ssh/*', '*.env', 'node_modules/**'],
    sensitiveFiles: ['.env', '.env.local', 'credentials.json', 'secrets.yml', '.aws/credentials'],
  },
} as const;

/**
 * Deep clone a fixture to prevent test pollution
 */
export function cloneFixture<T>(fixture: T): T {
  return JSON.parse(JSON.stringify(fixture));
}
