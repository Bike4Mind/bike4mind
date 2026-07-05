import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

// Mock dependencies BEFORE importing
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: vi.fn(() => ({
    post: vi.fn((handler: (req: unknown, res: unknown) => Promise<unknown>) => handler),
  })),
}));

vi.mock('sst', () => ({
  Resource: {
    websocket: {
      managementEndpoint: 'https://ws.example.com/dev',
    },
  },
}));

vi.mock('@server/websocket/utils', () => ({
  sendToConnection: vi.fn(),
}));

vi.mock('@bike4mind/database/social', () => ({
  Connection: {
    find: vi.fn(),
    deleteOne: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@bike4mind/database/content', () => ({
  Quest: {
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn(() => 'test-uuid-1234'),
  };
});

import { sendToConnection } from '@server/websocket/utils';
import { Connection } from '@bike4mind/database/social';
import { Quest } from '@bike4mind/database/content';

describe('/api/jupyter/execute', () => {
  let mockReq: {
    body: Record<string, unknown>;
    user: { id: string } | null;
  };
  let mockRes: {
    status: Mock;
    json: Mock;
  };

  const validNotebook = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [
      { cell_type: 'code', source: 'print("hello")', metadata: {} },
      { cell_type: 'markdown', source: '# Title', metadata: {} },
    ],
    metadata: {},
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      body: {},
      user: { id: 'user-123' },
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
  });

  describe('validation', () => {
    it('should return 400 if notebookJson is missing', async () => {
      mockReq.body = {
        sessionId: 'session-123',
      };

      // Import the handler dynamically to get fresh mocks
      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid request body',
        })
      );
    });

    it('should return 400 if sessionId is missing', async () => {
      mockReq.body = {
        notebookJson: validNotebook,
      };

      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid request body',
        })
      );
    });

    it('should return 400 if notebookJson is not valid JSON', async () => {
      mockReq.body = {
        notebookJson: 'not valid json {{{',
        sessionId: 'session-123',
      };

      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid notebook JSON',
        })
      );
    });

    it('should return 400 if notebook has no cells array', async () => {
      mockReq.body = {
        notebookJson: JSON.stringify({ nbformat: 4 }),
        sessionId: 'session-123',
      };

      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid notebook JSON: missing cells array',
        })
      );
    });
  });

  describe('connection handling', () => {
    it('should return 503 if no CLI connections available', async () => {
      mockReq.body = {
        notebookJson: validNotebook,
        sessionId: 'session-123',
      };

      (Connection.find as Mock).mockResolvedValue([]);

      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'No CLI connections available',
          hint: expect.stringContaining('Start the B4M CLI'),
        })
      );
    });
  });

  describe('successful execution', () => {
    beforeEach(() => {
      (Connection.find as Mock).mockResolvedValue([
        { connectionId: 'conn-1', userId: 'user-123', source: 'cli' },
        { connectionId: 'conn-2', userId: 'user-123', source: 'cli' },
      ]);
      (sendToConnection as Mock).mockResolvedValue(undefined);
      // findOneAndUpdate returns the updated document (or null if not found)
      (Quest.findOneAndUpdate as Mock).mockResolvedValue({ _id: 'quest-456' });
    });

    it('should send keep_command to first CLI connection and return success', async () => {
      mockReq.body = {
        notebookJson: validNotebook,
        sessionId: 'session-123',
      };

      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      // Should send to the first CLI connection only (not broadcast to all)
      expect(sendToConnection).toHaveBeenCalledWith(
        'conn-1', // First CLI connection ID
        'https://ws.example.com/dev',
        expect.objectContaining({
          action: 'keep_command',
          commandType: 'jupyter_execute_notebook',
          params: expect.objectContaining({
            notebookJson: validNotebook,
            sessionId: 'session-123',
            kernelName: 'python3',
          }),
          requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), // UUID format
        })
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          sent: true,
          sessionId: 'session-123',
          connections: 2,
        })
      );
    });

    it('should update Quest with initial notebook state when questId provided', async () => {
      mockReq.body = {
        notebookJson: validNotebook,
        sessionId: 'session-123',
        questId: 'quest-456',
      };

      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      // Uses findOneAndUpdate with userId filter for ownership check
      expect(Quest.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'quest-456', userId: 'user-123' },
        expect.objectContaining({
          $set: expect.objectContaining({
            'jupyterNotebook.status': 'executing',
            'jupyterNotebook.kernelName': 'python3',
            'jupyterNotebook.cellCount': 1, // Only non-empty code cells count
            'jupyterNotebook.executedCells': 0,
          }),
        }),
        { new: true }
      );
    });

    it('should use custom kernelName and timeoutPerCell when provided', async () => {
      mockReq.body = {
        notebookJson: validNotebook,
        sessionId: 'session-123',
        kernelName: 'julia-1.9',
        timeoutPerCell: 60000,
      };

      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      expect(sendToConnection).toHaveBeenCalledWith(
        'conn-1',
        'https://ws.example.com/dev',
        expect.objectContaining({
          params: expect.objectContaining({
            kernelName: 'julia-1.9',
            timeoutPerCell: 60000,
          }),
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 502 if sendToConnection fails', async () => {
      mockReq.body = {
        notebookJson: validNotebook,
        sessionId: 'session-123',
      };

      (Connection.find as Mock).mockResolvedValue([{ connectionId: 'conn-1', source: 'cli' }]);
      (sendToConnection as Mock).mockRejectedValue(new Error('WebSocket connection failed'));

      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(502);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Failed to send command to CLI',
          details: 'WebSocket connection failed',
        })
      );
    });

    it('should continue execution even if Quest update fails', async () => {
      mockReq.body = {
        notebookJson: validNotebook,
        sessionId: 'session-123',
        questId: 'quest-456',
      };

      (Connection.find as Mock).mockResolvedValue([{ connectionId: 'conn-1', source: 'cli' }]);
      (Quest.findOneAndUpdate as Mock).mockRejectedValue(new Error('DB error'));
      (sendToConnection as Mock).mockResolvedValue(undefined);

      const { default: handler } = await import('@client/pages/api/jupyter/execute');
      await handler(mockReq as any, mockRes as any);

      // Should still succeed despite Quest update failure
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          sent: true,
        })
      );
    });
  });
});
