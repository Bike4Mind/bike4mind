import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

// Mock dependencies BEFORE importing
vi.mock('@bike4mind/database/content', () => ({
  Quest: {
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock('@bike4mind/database/social', () => ({
  Connection: {
    findOne: vi.fn(),
  },
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
  sendToClient: vi.fn(),
}));

import { Quest } from '@bike4mind/database/content';
import { Connection } from '@bike4mind/database/social';
import { sendToClient } from '@server/websocket/utils';

describe('jupyterNotebookProgress WebSocket handler', () => {
  let mockEvent: {
    requestContext: {
      connectionId: string;
      domainName: string;
      stage: string;
    };
    body: string;
  };
  let mockContext: Record<string, unknown>;
  let mockLogger: {
    info: Mock;
    error: Mock;
    warn: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockEvent = {
      requestContext: {
        connectionId: 'conn-123',
        domainName: 'ws.example.com',
        stage: 'dev',
      },
      body: '',
    };

    mockContext = {};

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
  });

  const createCellOutputBody = (overrides = {}) =>
    JSON.stringify({
      action: 'jupyter_cell_output',
      requestId: 'req-123',
      sessionId: 'session-456',
      jupyterSessionId: 'jupyter-789',
      cellIndex: 0,
      outputType: 'execute_result',
      content: { text: 'Hello World' },
      executionCount: 1,
      isComplete: true,
      ...overrides,
    });

  describe('message parsing', () => {
    it('should return 200 for invalid JSON body', async () => {
      mockEvent.body = 'not valid json';

      const { func } = await import('../jupyterNotebookProgress');
      const result = await func(mockEvent as any, mockContext as any, mockLogger as any);

      expect(result).toEqual({ statusCode: 200 });
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'), expect.anything());
    });

    it('should return 200 for missing required fields', async () => {
      mockEvent.body = JSON.stringify({ action: 'jupyter_cell_output' });

      const { func } = await import('../jupyterNotebookProgress');
      const result = await func(mockEvent as any, mockContext as any, mockLogger as any);

      expect(result).toEqual({ statusCode: 200 });
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('connection validation', () => {
    it('should return 200 for unknown connectionId', async () => {
      mockEvent.body = createCellOutputBody();
      (Connection.findOne as Mock).mockResolvedValue(null);

      const { func } = await import('../jupyterNotebookProgress');
      const result = await func(mockEvent as any, mockContext as any, mockLogger as any);

      expect(result).toEqual({ statusCode: 200 });
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Unknown connectionId'));
    });
  });

  describe('progress handling', () => {
    beforeEach(() => {
      (Connection.findOne as Mock).mockResolvedValue({
        connectionId: 'conn-123',
        userId: 'user-456',
      });
      (sendToClient as Mock).mockResolvedValue(undefined);
    });

    it('should update Quest and relay progress to clients on successful cell completion', async () => {
      mockEvent.body = createCellOutputBody({
        cellIndex: 2,
        outputType: 'execute_result',
        isComplete: true,
      });

      (Quest.findOne as Mock).mockResolvedValue({
        _id: 'quest-789',
        sessionId: 'session-456',
        jupyterNotebook: {
          status: 'executing',
          cellCount: 5,
        },
      });
      (Quest.findByIdAndUpdate as Mock).mockResolvedValue({});

      const { func } = await import('../jupyterNotebookProgress');
      const result = await func(mockEvent as any, mockContext as any, mockLogger as any);

      expect(result).toEqual({ statusCode: 200 });

      // Should update Quest with progress
      expect(Quest.findByIdAndUpdate).toHaveBeenCalledWith(
        'quest-789',
        expect.objectContaining({
          $set: expect.objectContaining({
            'jupyterNotebook.executedCells': 3, // cellIndex + 1 for complete
          }),
        })
      );

      // Should relay progress to web clients only (with sourceFilter)
      expect(sendToClient).toHaveBeenCalledWith(
        'user-456',
        'https://ws.example.com/dev',
        expect.objectContaining({
          action: 'jupyter_notebook_progress',
          questId: 'quest-789',
          sessionId: 'session-456',
          status: 'executing', // Still executing (not last cell)
          cellIndex: 2,
          totalCells: 5,
        }),
        { sourceFilter: 'web' }
      );
    });

    it('should record error information for error outputs', async () => {
      mockEvent.body = createCellOutputBody({
        cellIndex: 1,
        outputType: 'error',
        content: {
          ename: 'NameError',
          evalue: "name 'x' is not defined",
          traceback: [],
        },
        isComplete: true,
      });

      (Quest.findOne as Mock).mockResolvedValue({
        _id: 'quest-789',
        jupyterNotebook: { status: 'executing', cellCount: 3 },
      });
      (Quest.findByIdAndUpdate as Mock).mockResolvedValue({});

      const { func } = await import('../jupyterNotebookProgress');
      await func(mockEvent as any, mockContext as any, mockLogger as any);

      // Should record error in Quest and set status to 'failed'
      expect(Quest.findByIdAndUpdate).toHaveBeenCalledWith(
        'quest-789',
        expect.objectContaining({
          $set: expect.objectContaining({
            'jupyterNotebook.lastError': "NameError: name 'x' is not defined",
            'jupyterNotebook.status': 'failed',
            'jupyterNotebook.completedAt': expect.any(Date),
          }),
        })
      );

      // Should relay 'failed' status to web clients only
      expect(sendToClient).toHaveBeenCalledWith(
        'user-456',
        'https://ws.example.com/dev',
        expect.objectContaining({
          status: 'failed',
          error: "NameError: name 'x' is not defined",
        }),
        { sourceFilter: 'web' }
      );
    });

    it('should mark notebook as completed when last cell finishes', async () => {
      mockEvent.body = createCellOutputBody({
        cellIndex: 2, // Last cell (0-indexed, count is 3)
        outputType: 'execute_result',
        isComplete: true,
      });

      (Quest.findOne as Mock).mockResolvedValue({
        _id: 'quest-789',
        jupyterNotebook: { status: 'executing', cellCount: 3 },
      });
      (Quest.findByIdAndUpdate as Mock).mockResolvedValue({});

      const { func } = await import('../jupyterNotebookProgress');
      await func(mockEvent as any, mockContext as any, mockLogger as any);

      // Should set status to completed
      expect(Quest.findByIdAndUpdate).toHaveBeenCalledWith(
        'quest-789',
        expect.objectContaining({
          $set: expect.objectContaining({
            'jupyterNotebook.status': 'completed',
            'jupyterNotebook.completedAt': expect.any(Date),
          }),
        })
      );
    });

    it('should handle in-progress cell updates (isComplete=false)', async () => {
      mockEvent.body = createCellOutputBody({
        cellIndex: 0,
        outputType: 'stream',
        content: { text: 'Processing...', name: 'stdout' },
        isComplete: false,
      });

      (Quest.findOne as Mock).mockResolvedValue({
        _id: 'quest-789',
        jupyterNotebook: { status: 'executing', cellCount: 3 },
      });
      (Quest.findByIdAndUpdate as Mock).mockResolvedValue({});

      const { func } = await import('../jupyterNotebookProgress');
      await func(mockEvent as any, mockContext as any, mockLogger as any);

      // Should update executedCells without incrementing (isComplete=false)
      expect(Quest.findByIdAndUpdate).toHaveBeenCalledWith(
        'quest-789',
        expect.objectContaining({
          $set: expect.objectContaining({
            'jupyterNotebook.executedCells': 0, // cellIndex + 0 because not complete
          }),
        })
      );

      // Should relay with 'executing' status to web clients only
      expect(sendToClient).toHaveBeenCalledWith(
        'user-456',
        'https://ws.example.com/dev',
        expect.objectContaining({
          status: 'executing',
        }),
        { sourceFilter: 'web' }
      );
    });

    it('should handle case when no Quest is found', async () => {
      mockEvent.body = createCellOutputBody();
      (Quest.findOne as Mock).mockResolvedValue(null);

      const { func } = await import('../jupyterNotebookProgress');
      const result = await func(mockEvent as any, mockContext as any, mockLogger as any);

      expect(result).toEqual({ statusCode: 200 });

      // Should not update Quest
      expect(Quest.findByIdAndUpdate).not.toHaveBeenCalled();

      // Should still relay to web clients with empty questId
      expect(sendToClient).toHaveBeenCalledWith(
        'user-456',
        'https://ws.example.com/dev',
        expect.objectContaining({
          questId: '',
        }),
        { sourceFilter: 'web' }
      );
    });
  });
});
