import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSearchCommand } from '../handlers/search-handler';

const { MockLogger, mockSearchMessages } = vi.hoisted(() => {
  const mockInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };

  const MockLogger = vi.fn(function () {
    return mockInstance;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (MockLogger as any).error = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (MockLogger as any).info = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (MockLogger as any).warn = vi.fn();

  const mockSearchMessages = vi.fn();

  return { MockLogger, mockSearchMessages };
});

vi.mock('../SlackClient', () => {
  return {
    SlackClient: vi.fn().mockImplementation(function () {
      return {
        searchMessages: mockSearchMessages,
      };
    }),
  };
});

vi.mock('@bike4mind/observability', () => ({
  Logger: MockLogger,
}));

describe('Search Handler', () => {
  const mockDbUser = { id: 'user123' };
  const mockSlackUserId = 'U123456';
  const mockUserToken = 'xoxp-mock-user-token';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error if no query provided', async () => {
    const result = await handleSearchCommand(mockDbUser, mockSlackUserId, '', mockUserToken);
    expect(result.text).toContain('Please provide a search query');
  });

  it('should return error if no user token provided', async () => {
    const result = await handleSearchCommand(mockDbUser, mockSlackUserId, 'test', undefined);
    expect(result.text).toContain('authorize B4M to search');
  });

  it('should return results when messages found', async () => {
    mockSearchMessages.mockResolvedValue({
      total: 1,
      matches: [
        {
          ts: '1234567890.123456',
          channel: { id: 'C123', name: 'general' },
          permalink: 'https://slack.com/archives/C123/p1234567890123456',
          username: 'testuser',
          text: 'This is a test message',
        },
      ],
    });

    const result = await handleSearchCommand(mockDbUser, mockSlackUserId, 'test', mockUserToken);

    expect(result.text).toBeTruthy();
    expect(result.blocks).toBeDefined();
    expect(result.blocks!.length).toBeGreaterThan(0);

    // Find the message block (it's dynamically constructed)
    const messageBlock = result.blocks!.find(
      (b: any) =>
        b.type === 'section' && b.text?.text?.includes('testuser') && b.text?.text?.includes('This is a test message')
    );

    expect(messageBlock).toBeDefined();
  });

  it('should handle no results found', async () => {
    mockSearchMessages.mockResolvedValue({
      total: 0,
      matches: [],
    });

    const result = await handleSearchCommand(mockDbUser, mockSlackUserId, 'nonexistent', mockUserToken);

    expect(result.text).toContain('No messages found');
  });

  it('should handle missing scope error', async () => {
    const error = new Error('Missing scope');
    (error as unknown as { data: { error: string } }).data = { error: 'missing_scope' };
    mockSearchMessages.mockRejectedValue(error);

    const result = await handleSearchCommand(mockDbUser, mockSlackUserId, 'test', mockUserToken);

    expect(result.text).toContain('missing `search:read` scope');
  });

  it('should handle invalid token error', async () => {
    const error = new Error('Not authed');
    (error as unknown as { data: { error: string } }).data = { error: 'not_authed' };
    mockSearchMessages.mockRejectedValue(error);

    const result = await handleSearchCommand(mockDbUser, mockSlackUserId, 'test', mockUserToken);

    expect(result.text).toContain('User token is invalid or expired');
  });
});
