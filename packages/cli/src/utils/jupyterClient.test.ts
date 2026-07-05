import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { JupyterClient, JupyterClientError, createJupyterClientFromEnv } from './jupyterClient';
import WebSocket from 'ws';

// WebSocket ready state for tests
const WS_OPEN = 1;

// Mock the ws module
vi.mock('ws', () => {
  const MockWebSocket = vi.fn() as Mock & { OPEN: number; CONNECTING: number };
  MockWebSocket.OPEN = 1;
  MockWebSocket.CONNECTING = 0;
  return { default: MockWebSocket };
});

describe('JupyterClient', () => {
  describe('constructor', () => {
    it('should create client with valid http URL', () => {
      const client = new JupyterClient({ serverUrl: 'http://localhost:8888' });
      expect(client).toBeInstanceOf(JupyterClient);
    });

    it('should create client with valid https URL', () => {
      const client = new JupyterClient({ serverUrl: 'https://jupyter.example.com' });
      expect(client).toBeInstanceOf(JupyterClient);
    });

    it('should normalize trailing slash in URL', () => {
      const client = new JupyterClient({ serverUrl: 'http://localhost:8888/' });
      // Access private field via any for testing
      expect((client as any).serverUrl).toBe('http://localhost:8888');
    });

    it('should throw for invalid URL', () => {
      expect(() => {
        new JupyterClient({ serverUrl: 'not-a-url' });
      }).toThrow(JupyterClientError);
    });

    it('should throw for empty URL', () => {
      expect(() => {
        new JupyterClient({ serverUrl: '' });
      }).toThrow('Server URL is required');
    });

    it('should throw for non-http protocol', () => {
      expect(() => {
        new JupyterClient({ serverUrl: 'ftp://localhost:8888' });
      }).toThrow('Invalid protocol');
    });

    it('should throw for file protocol', () => {
      expect(() => {
        new JupyterClient({ serverUrl: 'file:///etc/passwd' });
      }).toThrow('Invalid protocol');
    });
  });

  describe('startSession validation', () => {
    let client: JupyterClient;

    beforeEach(() => {
      client = new JupyterClient({ serverUrl: 'http://localhost:8888' });
      // Mock fetch to prevent actual network calls
      global.fetch = vi.fn().mockRejectedValue(new Error('Network disabled in tests'));
    });

    it('should throw for empty notebook path', async () => {
      await expect(client.startSession('')).rejects.toThrow('Notebook path is required');
    });

    it('should throw for path traversal attempt', async () => {
      await expect(client.startSession('../../../etc/passwd')).rejects.toThrow('path traversal not allowed');
    });

    it('should throw for path with control characters', async () => {
      await expect(client.startSession('notebook\x00.ipynb')).rejects.toThrow('contains control characters');
    });

    it('should throw for invalid kernel name', async () => {
      await expect(client.startSession('valid.ipynb', 'malicious-kernel')).rejects.toThrow(
        "Invalid kernel: 'malicious-kernel'"
      );
    });

    it('should accept valid kernel names', async () => {
      // Will fail on network but not on validation
      await expect(client.startSession('notebook.ipynb', 'python3')).rejects.toThrow('Network disabled');
      await expect(client.startSession('notebook.ipynb', 'ir')).rejects.toThrow('Network disabled');
      await expect(client.startSession('notebook.ipynb', 'julia-1.10')).rejects.toThrow('Network disabled');
    });
  });

  describe('createJupyterClientFromEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return null when JUPYTER_SERVER_URL not set', () => {
      delete process.env.JUPYTER_SERVER_URL;
      const client = createJupyterClientFromEnv();
      expect(client).toBeNull();
    });

    it('should create client from environment variables', () => {
      process.env.JUPYTER_SERVER_URL = 'http://localhost:8888';
      process.env.JUPYTER_TOKEN = 'test-token';

      const client = createJupyterClientFromEnv();
      expect(client).toBeInstanceOf(JupyterClient);
    });

    it('should work without token', () => {
      process.env.JUPYTER_SERVER_URL = 'http://localhost:8888';
      delete process.env.JUPYTER_TOKEN;

      const client = createJupyterClientFromEnv();
      expect(client).toBeInstanceOf(JupyterClient);
    });
  });

  describe('JupyterClientError', () => {
    it('should create error with message only', () => {
      const error = new JupyterClientError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('JupyterClientError');
      expect(error.statusCode).toBeUndefined();
    });

    it('should create error with status code', () => {
      const error = new JupyterClientError('Not found', 404);
      expect(error.statusCode).toBe(404);
    });

    it('should create error with response body', () => {
      const response = { detail: 'Kernel not found' };
      const error = new JupyterClientError('Error', 404, response);
      expect(error.response).toEqual(response);
    });

    it('should be an instance of Error', () => {
      const error = new JupyterClientError('Test');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('getHeaders', () => {
    it('should include Authorization header when token provided', () => {
      const client = new JupyterClient({
        serverUrl: 'http://localhost:8888',
        token: 'my-secret-token',
      });

      // Access private method via any for testing
      const headers = (client as any).getHeaders();
      expect(headers['Authorization']).toBe('token my-secret-token');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should not include Authorization header without token', () => {
      const client = new JupyterClient({ serverUrl: 'http://localhost:8888' });

      const headers = (client as any).getHeaders();
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('getKernelWebSocketUrl', () => {
    it('should generate ws:// URL for http:// server', () => {
      const client = new JupyterClient({ serverUrl: 'http://localhost:8888' });
      const wsUrl = (client as any).getKernelWebSocketUrl('kernel-123');
      expect(wsUrl).toBe('ws://localhost:8888/api/kernels/kernel-123/channels');
    });

    it('should generate wss:// URL for https:// server', () => {
      const client = new JupyterClient({ serverUrl: 'https://jupyter.example.com' });
      const wsUrl = (client as any).getKernelWebSocketUrl('kernel-456');
      expect(wsUrl).toBe('wss://jupyter.example.com/api/kernels/kernel-456/channels');
    });

    it('should include token as query parameter', () => {
      const client = new JupyterClient({
        serverUrl: 'http://localhost:8888',
        token: 'my-token',
      });
      const wsUrl = (client as any).getKernelWebSocketUrl('kernel-789');
      expect(wsUrl).toBe('ws://localhost:8888/api/kernels/kernel-789/channels?token=my-token');
    });
  });

  describe('generateMsgId', () => {
    it('should generate unique message IDs', () => {
      const client = new JupyterClient({ serverUrl: 'http://localhost:8888' });
      const id1 = (client as any).generateMsgId();
      const id2 = (client as any).generateMsgId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^\d+-[a-z0-9]+$/);
    });
  });

  describe('executeCell', () => {
    let client: JupyterClient;
    let mockWsInstance: {
      on: Mock;
      send: Mock;
      close: Mock;
      readyState: number;
    };

    beforeEach(() => {
      client = new JupyterClient({ serverUrl: 'http://localhost:8888' });

      // Create mock WebSocket instance
      mockWsInstance = {
        on: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        readyState: WS_OPEN,
      };

      // Make WebSocket constructor return our mock instance
      (WebSocket as unknown as Mock).mockImplementation(function () {
        return mockWsInstance;
      });
    });

    it('should send execute_request on WebSocket open', async () => {
      // Set up the mock to trigger 'open' event immediately
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockWsInstance.on.mockImplementation((event: string, callback: (data?: any) => void) => {
        if (event === 'open') {
          setTimeout(() => callback(), 0);
        }
        if (event === 'message') {
          // Simulate execute_reply after a short delay
          setTimeout(() => {
            const msgId = JSON.parse(mockWsInstance.send.mock.calls[0][0]).header.msg_id;
            callback(
              JSON.stringify({
                parent_header: { msg_id: msgId },
                header: { msg_type: 'execute_reply' },
                content: { status: 'ok', execution_count: 1 },
              })
            );
          }, 10);
        }
        return mockWsInstance;
      });

      const result = await client.executeCell('kernel-123', 'print("hello")');

      // Verify WebSocket was created with correct URL
      expect(WebSocket).toHaveBeenCalledWith('ws://localhost:8888/api/kernels/kernel-123/channels');

      // Verify execute_request was sent
      expect(mockWsInstance.send).toHaveBeenCalled();
      const sentMessage = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sentMessage.header.msg_type).toBe('execute_request');
      expect(sentMessage.content.code).toBe('print("hello")');
      expect(sentMessage.channel).toBe('shell');

      // Verify result
      expect(result.success).toBe(true);
      expect(result.executionCount).toBe(1);
    });

    it('should collect stream outputs', async () => {
      mockWsInstance.on.mockImplementation((event: string, callback: (data?: string) => void) => {
        if (event === 'open') {
          setTimeout(callback, 0);
        }
        if (event === 'message') {
          setTimeout(() => {
            const msgId = JSON.parse(mockWsInstance.send.mock.calls[0][0]).header.msg_id;

            // Send stream output
            callback(
              JSON.stringify({
                parent_header: { msg_id: msgId },
                header: { msg_type: 'stream' },
                content: { name: 'stdout', text: 'hello world\n' },
              })
            );

            // Send execute_reply
            callback(
              JSON.stringify({
                parent_header: { msg_id: msgId },
                header: { msg_type: 'execute_reply' },
                content: { status: 'ok', execution_count: 1 },
              })
            );
          }, 10);
        }
        return mockWsInstance;
      });

      const result = await client.executeCell('kernel-123', 'print("hello world")');

      expect(result.success).toBe(true);
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0].output_type).toBe('stream');
      expect(result.outputs[0].text).toBe('hello world\n');
    });

    it('should handle execution errors', async () => {
      mockWsInstance.on.mockImplementation((event: string, callback: (data?: string) => void) => {
        if (event === 'open') {
          setTimeout(callback, 0);
        }
        if (event === 'message') {
          setTimeout(() => {
            const msgId = JSON.parse(mockWsInstance.send.mock.calls[0][0]).header.msg_id;

            // Send error output
            callback(
              JSON.stringify({
                parent_header: { msg_id: msgId },
                header: { msg_type: 'error' },
                content: {
                  ename: 'NameError',
                  evalue: "name 'undefined_var' is not defined",
                  traceback: ['Traceback...', "NameError: name 'undefined_var' is not defined"],
                },
              })
            );

            // Send execute_reply with error status
            callback(
              JSON.stringify({
                parent_header: { msg_id: msgId },
                header: { msg_type: 'execute_reply' },
                content: { status: 'error', execution_count: 2 },
              })
            );
          }, 10);
        }
        return mockWsInstance;
      });

      const result = await client.executeCell('kernel-123', 'print(undefined_var)');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.ename).toBe('NameError');
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0].output_type).toBe('error');
    });

    it('should timeout if execution takes too long', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockWsInstance.on.mockImplementation((event: string, callback: (data?: any) => void) => {
        if (event === 'open') {
          setTimeout(() => callback(), 0);
        }
        // Never send execute_reply - simulate hanging execution
        return mockWsInstance;
      });

      await expect(client.executeCell('kernel-123', 'import time; time.sleep(100)', 50)).rejects.toThrow(
        'Cell execution timed out after 50ms'
      );

      expect(mockWsInstance.close).toHaveBeenCalled();
    });

    it('should handle WebSocket errors', async () => {
      mockWsInstance.on.mockImplementation((event: string, callback: (err?: Error) => void) => {
        if (event === 'error') {
          setTimeout(() => callback(new Error('Connection refused')), 0);
        }
        return mockWsInstance;
      });

      await expect(client.executeCell('kernel-123', 'print("test")')).rejects.toThrow(
        'WebSocket error: Connection refused'
      );
    });
  });
});
