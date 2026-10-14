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

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { ChatCompletionInvoke } from '@bike4mind/services/llm/ChatCompletionInvoke';
import { getControlledManifestFields } from '@bike4mind/common';
import {
  WorkflowStepHandler,
  FunctionExecutedEvent,
  WORKFLOW_STEP_CALLBACKS,
  resolveActingSlackUserId,
} from '../WorkflowStepHandler';

// Mock DI registry
const mockUser = { findOne: vi.fn() };
const mockSession = { findById: vi.fn(), findOne: vi.fn() };
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
    chatCompletionDefaults: { defaultChatCompletionOptions: {}, getSharedTokenizer: vi.fn() },
    eventBus: { LLMEvents: { CompletionStart: { publish: vi.fn() } } },
  }),
  getSlackDb: () => ({
    User: mockUser,
    Session: mockSession,
    Quest: mockQuest,
    defineAbilitiesFor: vi.fn().mockReturnValue({}),
  }),
}));

vi.mock('@bike4mind/services/llm/ChatCompletionInvoke', () => ({
  ChatCompletionInvoke: vi.fn().mockImplementation(function () {
    return { invoke: vi.fn().mockResolvedValue({}) };
  }),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: Object.assign(vi.fn(), { info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@bike4mind/utils', () => ({
  createTokenizer: vi.fn().mockReturnValue({}),
  SQSService: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

// Aliases so the test body can reference the DI mocks by their short names
const User = mockUser;
const Session = mockSession;
const Quest = mockQuest;
const createSession = mockCreateSession;
const addMessageToSession = mockAddMessageToSession;

// What Slack attests for the person running the workflow
const ACTING_USER_CONTEXT = { id: 'U123', secret: 'test-secret' };

const SAVED_NOTEBOOK = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_NOTEBOOK = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const FOREIGN_NOTEBOOK = 'cccccccccccccccccccccccc';
const GLOBAL_WRITE_NOTEBOOK = 'dddddddddddddddddddddddd';

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
    // Saved notebook ids are access-checked; every notebook is the user's own unless a test says otherwise.
    mockSession.findOne.mockImplementation(async ({ _id }: { _id: string }) =>
      _id === FOREIGN_NOTEBOOK
        ? { id: _id, userId: 'someone_else' }
        : _id === GLOBAL_WRITE_NOTEBOOK
          ? { id: _id, userId: 'someone_else', isGlobalWrite: true }
          : { id: _id, userId: 'user_123' }
    );
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
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, { user_context: ACTING_USER_CONTEXT });
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
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, { user_context: ACTING_USER_CONTEXT });
      event.function_execution_id = '   ';

      await handler.handleFunctionExecuted(event);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[WorkflowStep] Invalid event: missing function_execution_id',
        expect.any(Object)
      );
    });

    it('should reject events with missing callback_id', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, { user_context: ACTING_USER_CONTEXT });
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
      const event = createEvent('unknown_callback', { user_context: ACTING_USER_CONTEXT });

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
        user_context: ACTING_USER_CONTEXT,
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

    it('should fail when user_context is missing', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {});

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Could not verify who is running this workflow. Start it from a trigger a person runs.'
      );
      expect(User.findOne).not.toHaveBeenCalled();
    });

    it('should fail when user is not linked', async () => {
      vi.mocked(User.findOne).mockResolvedValue(null);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
        // No notebook_name provided
      });

      await handler.handleFunctionExecuted(event);

      expect(createSession).toHaveBeenCalledWith(
        mockUser.id,
        expect.objectContaining({
          name: expect.stringContaining('Workflow'),
          origin: { channel: 'slack' },
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });
  });

  describe('handleSendMessage', () => {
    it('should send message successfully with wait_for_response=false', async () => {
      const mockUser = createMockUser({ lastNotebookId: SAVED_NOTEBOOK });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_context: ACTING_USER_CONTEXT,
        message: 'Hello B4M!',
        wait_for_response: false,
      });

      await handler.handleFunctionExecuted(event);

      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        SAVED_NOTEBOOK,
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

    it('invokes the completion as an internal-origin caller', async () => {
      vi.mocked(User.findOne).mockResolvedValue(createMockUser({ lastNotebookId: SAVED_NOTEBOOK }));
      vi.mocked(addMessageToSession).mockResolvedValue({ id: 'quest_123' } as any);

      await handler.handleFunctionExecuted(
        createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
          user_context: ACTING_USER_CONTEXT,
          message: 'Hello',
          wait_for_response: false,
        })
      );

      // triggerAIProcessing is fire-and-forget, so the invoke lands after the handler resolves.
      await vi.waitFor(() => expect(vi.mocked(ChatCompletionInvoke).mock.results).toHaveLength(1));
      const { invoke } = vi.mocked(ChatCompletionInvoke).mock.results[0].value as { invoke: Mock };
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ authOrigin: 'internal' }));
    });

    it('should fail when message is missing', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
        message: '   ',
      });

      await handler.handleFunctionExecuted(event);

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Required input "message" is missing or empty'
      );
    });

    it('falls through a foreign saved default notebook to the last notebook', async () => {
      const mockUser = createMockUser({
        lastNotebookId: OTHER_NOTEBOOK,
        slackSettings: { slackUserId: 'U123', defaultNotebookId: FOREIGN_NOTEBOOK },
      });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({ id: 'quest_123' } as any);

      await handler.handleFunctionExecuted(
        createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, { user_context: ACTING_USER_CONTEXT, message: 'Hello' })
      );

      expect(createSession).not.toHaveBeenCalled();
      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        OTHER_NOTEBOOK,
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('uses an isGlobalWrite last notebook', async () => {
      const mockUser = createMockUser({ lastNotebookId: GLOBAL_WRITE_NOTEBOOK });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({ id: 'quest_123' } as any);

      await handler.handleFunctionExecuted(
        createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, { user_context: ACTING_USER_CONTEXT, message: 'Hello' })
      );

      expect(createSession).not.toHaveBeenCalled();
      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        GLOBAL_WRITE_NOTEBOOK,
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('creates a notebook instead of using a foreign last notebook', async () => {
      const mockUser = createMockUser({ lastNotebookId: FOREIGN_NOTEBOOK });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockResolvedValue({ id: 'new_notebook_123', name: 'Workflow Notebook' } as any);
      vi.mocked(addMessageToSession).mockResolvedValue({ id: 'quest_123' } as any);

      await handler.handleFunctionExecuted(
        createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, { user_context: ACTING_USER_CONTEXT, message: 'Hello' })
      );

      expect(createSession).toHaveBeenCalled();
      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        'new_notebook_123',
        expect.any(Object),
        expect.any(Object)
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
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
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
      const mockUser = createMockUser({ lastNotebookId: SAVED_NOTEBOOK });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);
      vi.mocked(Quest.findById).mockResolvedValue({
        status: 'done',
        replies: ['AI response here'],
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_context: ACTING_USER_CONTEXT,
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

    it('strips a b4m_cards fence out of outputs.response', async () => {
      const mockUser = createMockUser({ lastNotebookId: SAVED_NOTEBOOK });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);
      vi.mocked(Quest.findById).mockResolvedValue({
        status: 'done',
        replies: ['Here are some watches.\n\n```b4m_cards\n{"cards":[{"name":"Leaked"}]}\n```\n\nDone.'],
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_context: ACTING_USER_CONTEXT,
        message: 'Hello',
        wait_for_response: true,
      });

      await handler.handleFunctionExecuted(event);

      const call = mockSlackClient.functionCompleteSuccess.mock.calls[0][1] as { response: string };
      expect(call.response).not.toContain('b4m_cards');
      expect(call.response).not.toContain('"cards"');
      expect(call.response).toContain('Here are some watches.');
    });

    it('strips a b4m_cards fence out of the DM notificationMessage too', async () => {
      const mockUser = createMockUser({ lastNotebookId: SAVED_NOTEBOOK });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);
      vi.mocked(Quest.findById).mockResolvedValue({
        status: 'done',
        replies: ['Here are some watches.\n\n```b4m_cards\n{"cards":[{"name":"Leaked"}]}\n```\n\nDone.'],
      } as any);
      mockSlackClient.sendDirectMessage.mockResolvedValue(true);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, {
        user_context: ACTING_USER_CONTEXT,
        message: 'Hello',
        wait_for_response: true,
        send_notification: true,
      });

      await handler.handleFunctionExecuted(event);

      const [, notificationMessage] = mockSlackClient.sendDirectMessage.mock.calls[0] as [string, string];
      expect(notificationMessage).not.toContain('b4m_cards');
      expect(notificationMessage).not.toContain('"cards"');
    });
  });

  describe('handleQuery', () => {
    it('creates a notebook instead of using a foreign saved default notebook', async () => {
      const mockUser = createMockUser({
        slackSettings: { slackUserId: 'U123', defaultNotebookId: FOREIGN_NOTEBOOK },
      });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(createSession).mockResolvedValue({ id: 'new_notebook_123', name: 'Query' } as any);
      vi.mocked(addMessageToSession).mockResolvedValue({ id: 'quest_123' } as any);

      await handler.handleFunctionExecuted(
        createEvent(WORKFLOW_STEP_CALLBACKS.QUERY, { user_context: ACTING_USER_CONTEXT, query: 'What is the weather?' })
      );

      expect(createSession).toHaveBeenCalled();
      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        'new_notebook_123',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should submit query successfully', async () => {
      const mockUser = createMockUser({ lastNotebookId: SAVED_NOTEBOOK });
      vi.mocked(User.findOne).mockResolvedValue(mockUser);
      vi.mocked(addMessageToSession).mockResolvedValue({
        id: 'quest_123',
      } as any);
      vi.mocked(Session.findById).mockResolvedValue({
        name: 'Test Notebook',
      } as any);

      const event = createEvent(WORKFLOW_STEP_CALLBACKS.QUERY, {
        user_context: ACTING_USER_CONTEXT,
        query: 'What is the weather?',
      });

      await handler.handleFunctionExecuted(event);

      expect(addMessageToSession).toHaveBeenCalledWith(
        mockUser.id,
        SAVED_NOTEBOOK,
        expect.objectContaining({ prompt: 'What is the weather?' }),
        expect.any(Object)
      );
      expect(mockSlackClient.functionCompleteSuccess).toHaveBeenCalledWith(
        'Fx123456',
        expect.objectContaining({
          answer: expect.stringContaining('Query submitted'),
          notebook_id: SAVED_NOTEBOOK,
        })
      );
    });

    it('should fail when query is missing', async () => {
      const event = createEvent(WORKFLOW_STEP_CALLBACKS.QUERY, {
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
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
        user_context: ACTING_USER_CONTEXT,
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

  describe('acting user attestation', () => {
    const LEGACY_ERROR_FRAGMENT = 'update the app manifest';

    it('rejects a legacy user_id-only input and never looks up a user', async () => {
      await handler.handleFunctionExecuted(createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, { user_id: 'U123' }));

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        expect.stringContaining(LEGACY_ERROR_FRAGMENT)
      );
      expect(mockSlackClient.functionCompleteSuccess).not.toHaveBeenCalled();
      expect(User.findOne).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing secret', { id: 'U123' }],
      ['an empty secret', { id: 'U123', secret: '' }],
      ['an id that is not a Slack user id', { id: 'not-a-user', secret: 'test-secret' }],
      ['a string instead of an object', 'U123'],
    ])('rejects a malformed user_context with %s', async (_label, userContext) => {
      await handler.handleFunctionExecuted(
        createEvent(WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, { user_context: userContext, message: 'Hello' })
      );

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Could not verify who is running this workflow. Start it from a trigger a person runs.'
      );
      expect(User.findOne).not.toHaveBeenCalled();
    });

    it('runs as the user_context id and ignores a conflicting user_id', async () => {
      vi.mocked(User.findOne).mockResolvedValue(createMockUser());
      vi.mocked(createSession).mockResolvedValue({ id: 'session_123', name: 'Test' } as any);

      await handler.handleFunctionExecuted(
        createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
          user_context: ACTING_USER_CONTEXT,
          user_id: 'UVICTIM',
        })
      );

      expect(User.findOne).toHaveBeenCalledTimes(1);
      expect(User.findOne).toHaveBeenCalledWith({ 'slackSettings.slackUserId': 'U123' });
      expect(User.findOne).not.toHaveBeenCalledWith({ 'slackSettings.slackUserId': 'UVICTIM' });
    });

    it.each([
      ['a notebook step', WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {}],
      ['a message step that waits for the reply', WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, { wait_for_response: true }],
      ['a message step that does not wait', WORKFLOW_STEP_CALLBACKS.SEND_MESSAGE, { wait_for_response: false }],
      ['a query step', WORKFLOW_STEP_CALLBACKS.QUERY, {}],
    ])('%s runs as the user_context id and never the conflicting user_id', async (_label, callbackId, extraInputs) => {
      vi.mocked(User.findOne).mockResolvedValue(createMockUser());
      vi.mocked(createSession).mockResolvedValue({ id: 'session_123', name: 'Test' } as any);
      vi.mocked(addMessageToSession).mockResolvedValue({ id: 'quest_123' } as any);
      vi.mocked(Quest.findById).mockResolvedValue({ status: 'done', replies: ['ok'] } as any);
      vi.mocked(Session.findById).mockResolvedValue({ name: 'Test' } as any);
      mockSlackClient.sendDirectMessage.mockResolvedValue(true);

      await handler.handleFunctionExecuted(
        createEvent(callbackId, {
          user_context: ACTING_USER_CONTEXT,
          user_id: 'UVICTIM',
          message: 'Hello',
          query: 'What is new?',
          send_notification: true,
          ...extraInputs,
        })
      );

      expect(User.findOne).toHaveBeenCalledWith({ 'slackSettings.slackUserId': 'U123' });
      expect(User.findOne).not.toHaveBeenCalledWith({ 'slackSettings.slackUserId': 'UVICTIM' });
      // Assert the step actually reached the notification, so the DM target is pinned and not
      // passed vacuously by an error path that never sends one.
      expect(mockSlackClient.functionCompleteSuccess).toHaveBeenCalled();
      expect(mockSlackClient.sendDirectMessage).toHaveBeenCalledWith('U123', expect.any(String));
      expect(mockSlackClient.sendDirectMessage).not.toHaveBeenCalledWith('UVICTIM', expect.anything());
    });

    it('logs the rejection with the execution id, app id and reason', async () => {
      await handler.handleFunctionExecuted(createEvent(WORKFLOW_STEP_CALLBACKS.QUERY, { user_id: 'U123' }));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('without an attested acting user'),
        expect.objectContaining({
          callbackId: WORKFLOW_STEP_CALLBACKS.QUERY,
          functionExecutionId: 'Fx123456',
          appId: 'A123',
          reason: 'legacy_user_id_input',
        })
      );
    });

    it('sends the notification DM to the user_context id', async () => {
      vi.mocked(User.findOne).mockResolvedValue(createMockUser());
      vi.mocked(createSession).mockResolvedValue({ id: 'session_123', name: 'Test' } as any);
      mockSlackClient.sendDirectMessage.mockResolvedValue(true);

      await handler.handleFunctionExecuted(
        createEvent(WORKFLOW_STEP_CALLBACKS.CREATE_NOTEBOOK, {
          user_context: ACTING_USER_CONTEXT,
          user_id: 'UVICTIM',
          send_notification: true,
        })
      );

      expect(mockSlackClient.sendDirectMessage).toHaveBeenCalledWith('U123', expect.any(String));
      expect(mockSlackClient.sendDirectMessage).not.toHaveBeenCalledWith('UVICTIM', expect.anything());
    });

    it('still reports an unknown callback_id when user_context is absent', async () => {
      await handler.handleFunctionExecuted(createEvent('unknown_callback', {}));

      expect(mockSlackClient.functionCompleteError).toHaveBeenCalledWith(
        'Fx123456',
        'Unknown workflow step: unknown_callback'
      );
      expect(User.findOne).not.toHaveBeenCalled();
    });
  });
});

describe('workflow step manifest contract', () => {
  const functions = getControlledManifestFields('https://app.example.com', { enableWorkflowSteps: true }).functions;

  it.each(Object.values(WORKFLOW_STEP_CALLBACKS))(
    '%s declares the attested user_context input the handler resolves the acting user from',
    callbackId => {
      const inputs = functions?.[callbackId]?.input_parameters as Record<string, { type: string }> | undefined;
      expect(inputs?.user_context?.type).toBe('slack#/types/user_context');
      expect(Object.values(inputs ?? {}).map(input => input.type)).not.toContain('slack#/types/user_id');
    }
  );
});

describe('resolveActingSlackUserId', () => {
  it('returns the id from a valid user_context', () => {
    expect(resolveActingSlackUserId({ user_context: { id: 'U123ABC', secret: 's' } })).toEqual({
      ok: true,
      slackUserId: 'U123ABC',
    });
  });

  it('accepts a W-prefixed (enterprise) id', () => {
    expect(resolveActingSlackUserId({ user_context: { id: 'W123ABC', secret: 's' } })).toEqual({
      ok: true,
      slackUserId: 'W123ABC',
    });
  });

  it('prefers user_context over a user_id input', () => {
    expect(resolveActingSlackUserId({ user_context: { id: 'U123', secret: 's' }, user_id: 'UVICTIM' })).toEqual({
      ok: true,
      slackUserId: 'U123',
    });
  });

  it('flags a legacy user_id-only input as an outdated app configuration', () => {
    const result = resolveActingSlackUserId({ user_id: 'U123' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('legacy_user_id_input');
    expect(result.error).toContain('outdated app configuration');
    expect(result.error).toContain('update the app manifest');
  });

  it('flags an invalid user_context alongside a user_id as outdated configuration', () => {
    const result = resolveActingSlackUserId({ user_context: { id: 'U123' }, user_id: 'U123' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('update the app manifest');
  });

  it.each([
    ['no inputs', {}],
    ['a null user_context', { user_context: null }],
    ['a lowercase id', { user_context: { id: 'u123', secret: 's' } }],
    ['a too-short id', { user_context: { id: 'U1', secret: 's' } }],
    ['a non-string secret', { user_context: { id: 'U123', secret: 42 } }],
  ])('returns the generic verification error for %s', (_label, inputs) => {
    expect(resolveActingSlackUserId(inputs)).toEqual({
      ok: false,
      reason: 'missing_user_context',
      error: 'Could not verify who is running this workflow. Start it from a trigger a person runs.',
    });
  });
});
