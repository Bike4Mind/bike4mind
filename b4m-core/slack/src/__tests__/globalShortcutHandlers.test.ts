/**
 * Tests for Global Shortcut Handlers
 *
 * Tests the shortcuts menu (/ command) shortcuts for Slack integration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SHORTCUT_CALLBACK_IDS,
  handleGlobalShortcut,
  handleCreateNotebookSubmission,
  handleQuickAskSubmission,
  GlobalShortcutPayload,
  ViewSubmissionPayload,
} from '../handlers/globalShortcutHandlers';

// Mock WebClient
const mockViewsOpen = vi.fn();
const mockConversationsOpen = vi.fn();
const mockChatPostMessage = vi.fn();
const mockChatUpdate = vi.fn();

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return {
      views: { open: mockViewsOpen },
      conversations: { open: mockConversationsOpen },
      chat: { postMessage: mockChatPostMessage, update: mockChatUpdate },
    };
  }),
}));

// Mock database models
const mockUserFindOne = vi.fn();
const mockUserFindById = vi.fn();
const mockUserFindByIdAndUpdate = vi.fn();
const mockSessionFind = vi.fn();
const mockSessionFindById = vi.fn();
const mockQuestFindByIdAndUpdate = vi.fn();
const mockDefineAbilitiesFor = vi.fn();

// Mock session manager
const mockCreateSession = vi.fn();
const mockAddMessageToSession = vi.fn();

vi.mock('../di/registry', () => ({
  getSlackDb: () => ({
    User: {
      findOne: (...args: unknown[]) => mockUserFindOne(...args),
      findById: (...args: unknown[]) => mockUserFindById(...args),
      findByIdAndUpdate: (...args: unknown[]) => mockUserFindByIdAndUpdate(...args),
    },
    Session: {
      find: (...args: unknown[]) => mockSessionFind(...args),
      findById: (...args: unknown[]) => mockSessionFindById(...args),
    },
    Quest: {
      findByIdAndUpdate: (...args: unknown[]) => mockQuestFindByIdAndUpdate(...args),
    },
    defineAbilitiesFor: (...args: unknown[]) => mockDefineAbilitiesFor(...args),
  }),
  getSlackDeps: () => ({
    sessionManager: {
      createSession: (...args: unknown[]) => mockCreateSession(...args),
      addMessageToSession: (...args: unknown[]) => mockAddMessageToSession(...args),
    },
    eventBus: {
      LLMEvents: {
        CompletionStart: {
          publish: vi.fn(),
        },
      },
    },
    chatCompletionDefaults: {
      defaultChatCompletionOptions: {},
    },
  }),
}));

// Mock ChatCompletionInvoke
const mockInvoke = vi.fn();
vi.mock('@bike4mind/services', () => ({
  ChatCompletionInvoke: vi.fn().mockImplementation(function () {
    return {
      invoke: mockInvoke,
    };
  }),
}));

// Mock utilities
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn().mockImplementation(function () {
    return {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
  }),
}));

vi.mock('@bike4mind/utils', () => ({
  createTokenizer: vi.fn().mockReturnValue({}),
  SQSService: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

describe('GlobalShortcutHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // APP_URL is set per-deployment in prod; the notebook-link handler now reads it via
    // requireEnv (no brand fallback), so the test env must provide it or the
    // handler throws before the DM. Value is irrelevant to these assertions.
    process.env.APP_URL = 'https://app.example.com';
    mockViewsOpen.mockResolvedValue({ ok: true });
    mockConversationsOpen.mockResolvedValue({ ok: true, channel: { id: 'D12345' } });
    mockChatPostMessage.mockResolvedValue({ ok: true, ts: '1234567890.123456' });
    mockChatUpdate.mockResolvedValue({ ok: true });
  });

  describe('SHORTCUT_CALLBACK_IDS', () => {
    it('should have correct callback IDs', () => {
      expect(SHORTCUT_CALLBACK_IDS.CREATE_NOTEBOOK).toBe('create_notebook_shortcut');
      expect(SHORTCUT_CALLBACK_IDS.VIEW_NOTEBOOKS).toBe('view_notebooks_shortcut');
      expect(SHORTCUT_CALLBACK_IDS.QUICK_ASK).toBe('quick_ask_shortcut');
      expect(SHORTCUT_CALLBACK_IDS.HELP).toBe('help_shortcut');
    });

    it('should have all four shortcuts defined', () => {
      const keys = Object.keys(SHORTCUT_CALLBACK_IDS);
      expect(keys).toHaveLength(4);
      expect(keys).toContain('CREATE_NOTEBOOK');
      expect(keys).toContain('VIEW_NOTEBOOKS');
      expect(keys).toContain('QUICK_ASK');
      expect(keys).toContain('HELP');
    });
  });

  describe('handleGlobalShortcut', () => {
    const basePayload: GlobalShortcutPayload = {
      type: 'shortcut',
      callback_id: 'test_shortcut',
      trigger_id: 'trigger123',
      user: {
        id: 'U12345',
        name: 'testuser',
        team_id: 'T12345',
      },
      team: {
        id: 'T12345',
        domain: 'test-workspace',
      },
    };

    const mockUser = {
      id: 'user123',
      slackSettings: { slackUserId: 'U12345' },
    };

    it('should return empty object when bot token is missing', async () => {
      const result = await handleGlobalShortcut(basePayload, undefined);
      expect(result).toEqual({});
      expect(mockViewsOpen).not.toHaveBeenCalled();
    });

    it('should return empty object when trigger_id is missing', async () => {
      const payload = { ...basePayload, trigger_id: '' };
      const result = await handleGlobalShortcut(payload, 'xoxb-token');
      expect(result).toEqual({});
      expect(mockViewsOpen).not.toHaveBeenCalled();
    });

    it('should route to create notebook handler', async () => {
      const payload = { ...basePayload, callback_id: SHORTCUT_CALLBACK_IDS.CREATE_NOTEBOOK };
      mockUserFindOne.mockResolvedValue(mockUser);

      await handleGlobalShortcut(payload, 'xoxb-token', mockUser as any);

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(viewArg.view.callback_id).toBe('create_notebook_modal');
    });

    it('should route to view notebooks handler', async () => {
      const payload = { ...basePayload, callback_id: SHORTCUT_CALLBACK_IDS.VIEW_NOTEBOOKS };
      mockSessionFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      await handleGlobalShortcut(payload, 'xoxb-token', mockUser as any);

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(viewArg.view.title.text).toBe('My Notebooks');
    });

    it('should route to quick ask handler', async () => {
      const payload = { ...basePayload, callback_id: SHORTCUT_CALLBACK_IDS.QUICK_ASK };

      await handleGlobalShortcut(payload, 'xoxb-token', mockUser as any, 'TestBot', 'ws123');

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(viewArg.view.callback_id).toBe('quick_ask_modal');
    });

    it('should route to help handler', async () => {
      const payload = { ...basePayload, callback_id: SHORTCUT_CALLBACK_IDS.HELP };

      await handleGlobalShortcut(payload, 'xoxb-token', mockUser as any, 'TestBot');

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(viewArg.view.title.text).toBe('TestBot Help');
    });

    it('should use default help title when appName not provided', async () => {
      const payload = { ...basePayload, callback_id: SHORTCUT_CALLBACK_IDS.HELP };

      await handleGlobalShortcut(payload, 'xoxb-token', mockUser as any);

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(viewArg.view.title.text).toBe('B4M Help');
    });

    it('should return empty object for unknown callback_id', async () => {
      const payload = { ...basePayload, callback_id: 'unknown_shortcut' };
      const result = await handleGlobalShortcut(payload, 'xoxb-token', mockUser as any);
      expect(result).toEqual({});
    });

    it('should show unlinked user modal when user not found', async () => {
      const payload = { ...basePayload, callback_id: SHORTCUT_CALLBACK_IDS.CREATE_NOTEBOOK };
      mockUserFindOne.mockResolvedValue(null);

      await handleGlobalShortcut(payload, 'xoxb-token', null);

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(viewArg.view.title.text).toBe('Account Not Linked');
    });

    it('should look up user by Slack ID when not prefetched', async () => {
      const payload = { ...basePayload, callback_id: SHORTCUT_CALLBACK_IDS.CREATE_NOTEBOOK };
      mockUserFindOne.mockResolvedValue(mockUser);

      await handleGlobalShortcut(payload, 'xoxb-token');

      expect(mockUserFindOne).toHaveBeenCalledWith({
        'slackSettings.slackUserId': 'U12345',
      });
    });
  });

  describe('handleCreateNotebookSubmission', () => {
    const basePayload: ViewSubmissionPayload = {
      type: 'view_submission',
      user: { id: 'U12345', name: 'testuser' },
      view: {
        callback_id: 'create_notebook_modal',
        private_metadata: JSON.stringify({ userId: 'user123' }),
        state: {
          values: {
            notebook_name_block: {
              notebook_name_input: { value: 'My Test Notebook' },
            },
          },
        },
      },
    };

    beforeEach(() => {
      mockUserFindById.mockResolvedValue({
        id: 'user123',
        slackSettings: { slackUserId: 'U12345' },
      });
      mockDefineAbilitiesFor.mockReturnValue({});
      mockCreateSession.mockResolvedValue({ id: 'session123' });
    });

    it('should create notebook with provided name', async () => {
      const result = await handleCreateNotebookSubmission(basePayload, 'xoxb-token');

      expect(result).toEqual({});
      expect(mockCreateSession).toHaveBeenCalledWith('user123', { name: 'My Test Notebook' }, expect.anything(), {
        setLastNotebook: true,
      });
    });

    it('should generate default name when notebook name is empty', async () => {
      const payload = {
        ...basePayload,
        view: {
          ...basePayload.view,
          state: {
            values: {
              notebook_name_block: {
                notebook_name_input: { value: '' },
              },
            },
          },
        },
      };

      await handleCreateNotebookSubmission(payload, 'xoxb-token');

      expect(mockCreateSession).toHaveBeenCalledWith(
        'user123',
        { name: expect.stringContaining('Slack Chat') },
        expect.anything(),
        { setLastNotebook: true }
      );
    });

    it('should return error when userId is missing from metadata', async () => {
      const payload = {
        ...basePayload,
        view: {
          ...basePayload.view,
          private_metadata: JSON.stringify({}),
        },
      };

      const result = await handleCreateNotebookSubmission(payload);

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          notebook_name_block: 'Unable to identify user. Please try again.',
        },
      });
    });

    it('should return error when private_metadata is invalid JSON', async () => {
      const payload = {
        ...basePayload,
        view: {
          ...basePayload.view,
          private_metadata: 'invalid-json',
        },
      };

      const result = await handleCreateNotebookSubmission(payload);

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          notebook_name_block: 'Unable to identify user. Please try again.',
        },
      });
    });

    it('should return error when user not found in database', async () => {
      mockUserFindById.mockResolvedValue(null);

      const result = await handleCreateNotebookSubmission(basePayload, 'xoxb-token');

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          notebook_name_block: 'User not found. Please try again.',
        },
      });
    });

    it('should return unauthorized error when Slack user ID does not match (security check)', async () => {
      // Simulate an attacker trying to use another user's userId in private_metadata
      mockUserFindById.mockResolvedValue({
        id: 'user123',
        slackSettings: { slackUserId: 'U99999' }, // Different from payload's U12345
      });

      const result = await handleCreateNotebookSubmission(basePayload, 'xoxb-token');

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          notebook_name_block: 'Unauthorized access.',
        },
      });
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('should DM the user with notebook link when bot token provided', async () => {
      await handleCreateNotebookSubmission(basePayload, 'xoxb-token');

      // Wait for async DM to be triggered
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockConversationsOpen).toHaveBeenCalledWith({ users: 'U12345' });
      expect(mockChatPostMessage).toHaveBeenCalled();
    });

    it('should return error when session creation fails', async () => {
      mockCreateSession.mockRejectedValue(new Error('Database error'));

      const result = await handleCreateNotebookSubmission(basePayload, 'xoxb-token');

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          notebook_name_block: 'Failed to create notebook. Please try again.',
        },
      });
    });
  });

  describe('handleQuickAskSubmission', () => {
    const basePayload: ViewSubmissionPayload = {
      type: 'view_submission',
      user: { id: 'U12345' },
      view: {
        callback_id: 'quick_ask_modal',
        private_metadata: JSON.stringify({ userId: 'user123', workspaceId: 'ws123' }),
        state: {
          values: {
            question_block: {
              question_input: { value: 'What is the meaning of life?' },
            },
          },
        },
      },
    };

    beforeEach(() => {
      mockUserFindById.mockResolvedValue({
        id: 'user123',
        slackSettings: { slackUserId: 'U12345', defaultNotebookId: 'session123' },
      });
      mockDefineAbilitiesFor.mockReturnValue({});
      mockSessionFindById.mockResolvedValue({ id: 'session123' });
      mockAddMessageToSession.mockResolvedValue({ id: 'quest123' });
      mockInvoke.mockResolvedValue({});
    });

    it('should return empty response on valid submission', async () => {
      const result = await handleQuickAskSubmission(basePayload, 'xoxb-token');
      expect(result).toEqual({});
    });

    it('should return error when userId is missing from metadata', async () => {
      const payload = {
        ...basePayload,
        view: {
          ...basePayload.view,
          private_metadata: JSON.stringify({}),
        },
      };

      const result = await handleQuickAskSubmission(payload, 'xoxb-token');

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          question_block: 'Unable to identify user. Please try again.',
        },
      });
    });

    it('should return error when question is empty', async () => {
      const payload = {
        ...basePayload,
        view: {
          ...basePayload.view,
          state: {
            values: {
              question_block: {
                question_input: { value: '' },
              },
            },
          },
        },
      };

      const result = await handleQuickAskSubmission(payload, 'xoxb-token');

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          question_block: 'Please enter a question.',
        },
      });
    });

    it('should return error when question is whitespace only', async () => {
      const payload = {
        ...basePayload,
        view: {
          ...basePayload.view,
          state: {
            values: {
              question_block: {
                question_input: { value: '   ' },
              },
            },
          },
        },
      };

      const result = await handleQuickAskSubmission(payload, 'xoxb-token');

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          question_block: 'Please enter a question.',
        },
      });
    });

    it('should return error when bot token is missing', async () => {
      const result = await handleQuickAskSubmission(basePayload, undefined);

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          question_block: 'Bot token not available. Please try again.',
        },
      });
    });

    it('should use workspaceId from passed parameter if not in metadata', async () => {
      const payload = {
        ...basePayload,
        view: {
          ...basePayload.view,
          private_metadata: JSON.stringify({ userId: 'user123' }),
        },
      };

      const result = await handleQuickAskSubmission(payload, 'xoxb-token', 'passed-ws-id');
      expect(result).toEqual({});
    });

    it('should handle invalid JSON in private_metadata gracefully', async () => {
      const payload = {
        ...basePayload,
        view: {
          ...basePayload.view,
          private_metadata: 'invalid-json',
        },
      };

      const result = await handleQuickAskSubmission(payload, 'xoxb-token', 'ws123');

      // Should still fail because userId is missing
      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          question_block: 'Unable to identify user. Please try again.',
        },
      });
    });
  });

  describe('View Notebooks Modal', () => {
    const mockUser = {
      id: 'user123',
      slackSettings: { slackUserId: 'U12345' },
    };

    const basePayload: GlobalShortcutPayload = {
      type: 'shortcut',
      callback_id: SHORTCUT_CALLBACK_IDS.VIEW_NOTEBOOKS,
      trigger_id: 'trigger123',
      user: { id: 'U12345', name: 'testuser', team_id: 'T12345' },
      team: { id: 'T12345', domain: 'test-workspace' },
    };

    it('should display empty state when no notebooks exist', async () => {
      mockSessionFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      await handleGlobalShortcut(basePayload, 'xoxb-token', mockUser as any);

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(JSON.stringify(viewArg.view.blocks)).toContain('No notebooks found');
    });

    it('should display notebooks when they exist', async () => {
      const mockNotebooks = [
        { name: 'Test Notebook 1', updatedAt: new Date(), createdAt: new Date() },
        { name: 'Test Notebook 2', updatedAt: new Date(), createdAt: new Date() },
      ];

      mockSessionFind.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue(mockNotebooks),
            }),
          }),
        }),
      });

      await handleGlobalShortcut(basePayload, 'xoxb-token', mockUser as any);

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(JSON.stringify(viewArg.view.blocks)).toContain('Your Recent Notebooks');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('Test Notebook 1');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('Test Notebook 2');
    });
  });

  describe('Unlinked User Modal', () => {
    const basePayload: GlobalShortcutPayload = {
      type: 'shortcut',
      callback_id: SHORTCUT_CALLBACK_IDS.CREATE_NOTEBOOK,
      trigger_id: 'trigger123',
      user: { id: 'U12345', name: 'testuser', team_id: 'T12345' },
      team: { id: 'T12345', domain: 'test-workspace' },
    };

    it('should show unlinked modal with instructions', async () => {
      mockUserFindOne.mockResolvedValue(null);

      await handleGlobalShortcut(basePayload, 'xoxb-token');

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(viewArg.view.title.text).toBe('Account Not Linked');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('not linked');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('Profile Settings');
    });

    it('should include app name in unlinked modal', async () => {
      const payload = { ...basePayload, callback_id: SHORTCUT_CALLBACK_IDS.QUICK_ASK };
      mockUserFindOne.mockResolvedValue(null);

      await handleGlobalShortcut(payload, 'xoxb-token', null, 'CustomBot');

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(JSON.stringify(viewArg.view.blocks)).toContain('CustomBot');
    });
  });

  describe('Help Modal Content', () => {
    const payload: GlobalShortcutPayload = {
      type: 'shortcut',
      callback_id: SHORTCUT_CALLBACK_IDS.HELP,
      trigger_id: 'trigger123',
      user: { id: 'U12345', name: 'testuser', team_id: 'T12345' },
      team: { id: 'T12345', domain: 'test-workspace' },
    };

    it('should include AI agents section', async () => {
      await handleGlobalShortcut(payload, 'xoxb-token');

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(JSON.stringify(viewArg.view.blocks)).toContain('Available AI Agents');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('@agent');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('@pm');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('@dev');
    });

    it('should include slash commands section', async () => {
      await handleGlobalShortcut(payload, 'xoxb-token');

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(JSON.stringify(viewArg.view.blocks)).toContain('Slash Commands');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('/b4m schedule');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('/notebook');
    });

    it('should include shortcuts section', async () => {
      await handleGlobalShortcut(payload, 'xoxb-token');

      expect(mockViewsOpen).toHaveBeenCalled();
      const viewArg = mockViewsOpen.mock.calls[0][0];
      expect(JSON.stringify(viewArg.view.blocks)).toContain('Create Notebook');
      expect(JSON.stringify(viewArg.view.blocks)).toContain('Quick Ask');
    });
  });
});
