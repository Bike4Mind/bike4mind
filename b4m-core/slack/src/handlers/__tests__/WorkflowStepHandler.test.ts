/**
 * Tests for WorkflowStepHandler
 *
 * Covers:
 * - Event ID validation
 * - All three step handlers (CREATE_NOTEBOOK, SEND_MESSAGE, QUERY)
 * - Input validation
 * - User lookup failures
 * - Slack API error reporting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkflowStepHandler, FunctionExecutedEvent, WORKFLOW_STEP_CALLBACKS } from '../WorkflowStepHandler';

// Mock DI registry
const mockUser = { findOne: vi.fn() };
const mockSession = { findById: vi.fn() };
const mockQuest = { findById: vi.fn() };
const mockCreateSession = vi.fn();
const mockAddMessageToSession = vi.fn();

vi.mock('../../di/registry', () => ({
  getSlackDeps: () => ({
    sessionManager: {
      createSession: mockCreateSession,
      addMessageToSession: mockAddMessageToSession,
    },
    authAbility: { defineAbilitiesFor: vi.fn().mockReturnValue({}) },
    chatCompletionDefaults: { defaultChatCompletionOptions: {} },
    eventBus: { LLMEvents: { CompletionStart: { publish: vi.fn() } } },
  }),
  getSlackDb: () => ({
    User: mockUser,
    Session: mockSession,
    Quest: mockQuest,
    defineAbilitiesFor: vi.fn().mockReturnValue({}),
  }),
}));

vi.mock('@bike4mind/services', () => ({
  ChatCompletionInvoke: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(),
}));

vi.mock('@bike4mind/utils', () => ({
  createTokenizer: vi.fn().mockReturnValue({}),
  SQSService: vi.fn().mockImplementation(() => ({})),
}));

// Aliases so the test body can reference the DI mocks by their short names
const User = mockUser;
const Session = mockSession;
const Quest = mockQuest;
const createSession = mockCreateSession;
const addMessageToSession = mockAddMessageToSession;

// Mock SlackClient
const mockSlackClient = {
  functionCompleteSuccess: vi.fn(),
  functionCompleteError: vi.fn(),
  sendDirectMessage: vi.fn(),
};

// Mock Logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('WorkflowStepHandler', () => {
  let handler: WorkflowStepHandler;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, APP_URL: 'https://app.test.com' };
    handler = new WorkflowStepHandler(mockSlackClient as any, mockLogger as any);
    mockSlackClient.functionCompleteSuccess.mockResolvedValue(true);
    mockSlackClient.functionCompleteError.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Helper to create a valid event
  const createEvent = (callbackId: string, inputs: Record<string, unknown>): FunctionExecutedEvent => ({
    type: 'function_executed',
    function: {
      id: 'func_123',
      callback_id: callbackId,
      title: 'Test Function',
      type: 'custom',
      app_id: 'A123',
    },
    inputs,
    function_execution_id: 'Fx123456',
    workflow_execution_id: 'Wf123456',
    event_ts: '1234567890.123456',
  });

  // Helper to create a mock user
  const createMockUser = (overrides = {}) => ({
    id: 'user_123',
    _id: 'user_123',
    organizationId: 'org_123',
    slackSettings: {
      slackUserId: 'U123',
      defaultNotebookId: null,
    },
    lastNotebookId: null,
    ...overrides,
  });

  describe('Event ID Validation', () => {
    it('should reject events with missing function_execution_id', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, { user_id: 'U123' });
      event.function_execution_id = '';

      await handler.handleFunctionExecuted(event);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[WorkflowStep] Invalid event: missing function_execution_id',
        expect.any(Object)
      );
      expect(mockSlackClient.functionCompleteSuccess).not.toHaveBeenCalled();
      expect(mockSlackClient.functionCompleteError).not.toHaveBeenCalled();
    });

    it('should reject events with whitespace-only function_execution_id', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, { user_id: 'U123' });
      event.function_execution_id = '   ';

      await handler.handleFunctionExecuted(event);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[WorkflowStep] Invalid event: missing function_execution_id',
        expect.any(Object)
      );
    });

    it('should reject events with missing callback_id', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, { user_id: 'U123' });
      event.function.callback_id = '';

      await handler.handleFunctionExecuted(event);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[WorkflowStep] Invalid event: missing callback_id',
        expect.any(Object)
      );
      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Invalid workflow step: missing callback_id'
      );
    });

    it('should handle unknown callback_id', async () => {
      const event = createEvent('unknown_callback', { user_id: 'U123' });

      await handler.handleFunctionExecuted(event);

      expect(mockLogger.warn).toHaveBeenCalledWith('[WorkflowStep] Unknown callback_id', {
        callbackId: 'unknown_callback',
      });
      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Unknown workflow step: unknown_callback'
      );
    });
  });

  describe('handleCreateNotebook', () => {
    it('should create notebook successfully', async () => {
      const mockUser = createMockUser();
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockResolvedValue({
        id: 'session_123',
        name: 'Test Notebook',
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
        notebook_name: 'Test Notebook',
      });

      await handler.handleFunctionExecuted(event);

      expect(User.findOne).toHaveBeenCalledWith({ 'slackSettings.slackUserId': 'U123' });
      expect(createSession).toHaveBeenCalled();
      expect(mockSlackClient.functionCompleteSuccess).toHaveBeenCalledWith(
        'Fx123456',
        expect.objectContaining({
          notebook_id: 'session_123',
          notebook_name: 'Test Notebook',
          notebook_url: 'https://app.test.com/notebooks/session_123',
        })
      );
    });

    it('should fail when user_id is missing', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {});

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Required input "user_id" is missing or invalid'
      );
    });

    it('should fail when user is not linked', async () => {
      vi.mocked(User.findOne).mockResolvedValue(null);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        expect.stringContaining('not linked to B4M')
      );
    });

    it('should fail when APP_URL is not configured', async () => {
      delete process.env.APP_URL;

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        expect.stringContaining('APP_URL is not set')
      );
    });

    it('should generate default notebook name when not provided', async () => {
      const mockUser = createMockUser();
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockResolvedValue({
        id: 'session_123',
        name: 'Workflow - Jan 15, 2026, 10:30 AM',
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
        // No notebook_name provided
      });

      await handler.handleFunctionExecuted(event);

      expect(createSession).toHaveBeenCalledWith(
        mockUser.id,
        expect.objectContaining({ name: expect.stringContaining('Workflow') }),
        expect.any(Object),
        expect.any(Object)
      );
    });
  });

  describe('handleSendMessage', () => {
    it('should send message successfully with wait_for_response=false', async () => {
      const mockUser = createMockUser({ lastNotebookId: 'existing_notebook' });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_id: 'U123',
        message: 'Hello B4M!',
        wait_for_response: false,
      });

      await handler.handleFunctionExecuted(event);

      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        'existing_notebook',
        expect.objectContaining({ prompt: 'Hello B4M!' }),
        expect.any(Object)
      );
      expect(mockSlackClient.functionCompleteSuccess).toHaveBeenCalledWith(
        'Fx123456',
        expect.objectContaining({
          quest_id: 'quest_123',
          response: 'Message sent to notebook.',
        })
      );
    });

    it('should fail when message is missing', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_id: 'U123',
        // No message
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Required input "message" is missing or empty'
      );
    });

    it('should fail when message is empty string', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_id: 'U123',
        message: '   ',
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Required input "message" is missing or empty'
      );
    });

    it('should create new notebook when none exists', async () => {
      const mockUser = createMockUser({
        lastNotebookId: null,
        slackSettings: { slackUserId: 'U123', defaultNotebookId: null },
      });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockResolvedValue({
        id: 'new_notebook_123',
        name: 'Workflow Notebook',
      } as any);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_id: 'U123',
        message: 'Hello',
        wait_for_response: false,
      });

      await handler.handleFunctionExecuted(event);

      expect(createSession).toHaveBeenCalled();
      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        'new_notebook_123',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should use provided notebook_id when specified', async () => {
      const mockUser = createMockUser();
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_id: 'U123',
        message: 'Hello',
        notebook_id: 'specific_notebook_123',
        wait_for_response: false,
      });

      await handler.handleFunctionExecuted(event);

      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        'specific_notebook_123',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should wait for AI response when wait_for_response=true', async () => {
      const mockUser = createMockUser({ lastNotebookId: 'notebook_123' });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);
      vi.mocked(Quest.findById).mockResolvedValue({
        status: 'done',
        replies: ['AI response here'],
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_id: 'U123',
        message: 'Hello',
        wait_for_response: true,
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteSuccess).toHaveBeenCalledWith(
        'Fx123456',
        expect.objectContaining({
          response: 'AI response here',
        })
      );
    });
  });

  describe('handleQuery', () => {
    it('should submit query successfully', async () => {
      const mockUser = createMockUser({ lastNotebookId: 'notebook_123' });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);
      vi.mocked(Session.findById).mockResolvedValue({
        name: 'Test Notebook',
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.QUERY, {
        user_id: 'U123',
        query: 'What is the weather?',
      });

      await handler.handleFunctionExecuted(event);

      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        'notebook_123',
        expect.objectContaining({ prompt: 'What is the weather?' }),
        expect.any(Object)
      );
      expect(mockSlackClient.functionCompleteSuccess).toHaveBeenCalledWith(
        'Fx123456',
        expect.objectContaining({
          answer: expect.stringContaining('Query submitted'),
          notebook_id: 'notebook_123',
        })
      );
    });

    it('should fail when query is missing', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.QUERY, {
        user_id: 'U123',
        // No query
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Required input "query" is missing or empty'
      );
    });

    it('should fail when user is not linked', async () => {
      vi.mocked(User.findOne).mockResolvedValue(null);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.QUERY, {
        user_id: 'U123',
        query: 'Test query',
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        expect.stringContaining('not linked to B4M')
      );
    });
  });

  describe('Slack API Error Reporting', () => {
    it('should log critical error when functionCompleteSuccess fails', async () => {
      const mockUser = createMockUser();
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockResolvedValue({
        id: 'session_123',
        name: 'Test',
      } as any);
      mockSlackClient.functionCompleteSuccess.mockResolvedValue(false);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
      });

      await handler.handleFunctionExecuted(event);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[WorkflowStep] CRITICAL: Failed to report success to Slack - workflow may hang',
        expect.objectContaining({
          functionExecutionId: 'Fx123456',
          callbackId: WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK,
        })
      );
    });

    it('should log critical error when functionCompleteError fails', async () => {
      vi.mocked(User.findOne).mockResolvedValue(null);
      mockSlackClient.functionCompleteError.mockResolvedValue(false);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
      });

      await handler.handleFunctionExecuted(event);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[WorkflowStep] CRITICAL: Failed to report error to Slack - workflow may hang',
        expect.objectContaining({
          functionExecutionId: 'Fx123456',
        })
      );
    });

    it('should report unhandled errors to Slack', async () => {
      const mockUser = createMockUser();
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockRejectedValue(new Error('Database connection failed'));

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        expect.stringContaining('Failed to create notebook')
      );
    });
  });

  describe('DM Notifications', () => {
    it('should send DM when send_notification is true', async () => {
      const mockUser = createMockUser();
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockResolvedValue({
        id: 'session_123',
        name: 'Test',
      } as any);
      mockSlackClient.sendDirectMessage.mockResolvedValue(true);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
        send_notification: true,
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.sendDirectMessage).toHaveBeenCalledWith(
        'U123',
        expect.stringContaining('Notebook created')
      );
    });

    it('should not send DM when send_notification is false (default)', async () => {
      const mockUser = createMockUser();
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockResolvedValue({
        id: 'session_123',
        name: 'Test',
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
        // send_notification not set (defaults to false)
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.sendDirectMessage).not.toHaveBeenCalled();
    });

    it('should not fail workflow if DM fails', async () => {
      const mockUser = createMockUser();
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockResolvedValue({
        id: 'session_123',
        name: 'Test',
      } as any);
      mockSlackClient.sendDirectMessage.mockRejectedValue(new Error('DM failed'));

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_id: 'U123',
        send_notification: true,
      });

      await handler.handleFunctionExecuted(event);

      // Should still complete successfully
      expect(mockSlackClient.functionCompleteSuccess).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[WorkflowStep] Failed to send DM notification user requested',
        expect.any(Object)
      );
    });
  });
});
