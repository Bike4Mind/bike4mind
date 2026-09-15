import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @bike4mind/common validators before importing the module under test
vi.mock('@bike4mind/common', () => ({
  validateNotebookPath: () => ({ valid: true }),
  validateJupyterKernelName: () => ({ valid: true }),
}));

import {
  JupyterBrowserClient,
  JupyterBrowserError,
  getStoredJupyterConfig,
  setStoredJupyterConfig,
  clearStoredJupyterConfig,
} from '../jupyterBrowserClient';

// -- Helpers for mocking WebSocket and fetch --

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  sentMessages: string[] = [];

  constructor(public url: string) {
    // Simulate async open
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateMessage(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateError() {
    this.onerror?.();
  }
}

let mockWsInstance: MockWebSocket | null = null;

function setMockWsInstance(instance: MockWebSocket) {
  mockWsInstance = instance;
}

describe('JupyterBrowserClient', () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    mockWsInstance = null;
    // @ts-expect-error -- replacing global WebSocket with mock
    globalThis.WebSocket = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        setMockWsInstance(this);
      }
    };
    // @ts-expect-error -- static constants
    globalThis.WebSocket.OPEN = MockWebSocket.OPEN;
    // @ts-expect-error -- static constants
    globalThis.WebSocket.CONNECTING = MockWebSocket.CONNECTING;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('rejects non-http protocols', () => {
      expect(() => new JupyterBrowserClient({ serverUrl: 'ftp://localhost:8888' })).toThrow(JupyterBrowserError);
    });

    it('rejects invalid URLs', () => {
      expect(() => new JupyterBrowserClient({ serverUrl: 'not-a-url' })).toThrow(JupyterBrowserError);
    });

    it('accepts http URLs', () => {
      expect(() => new JupyterBrowserClient({ serverUrl: 'http://localhost:8888' })).not.toThrow();
    });

    it('strips trailing slash', () => {
      const client = new JupyterBrowserClient({ serverUrl: 'http://localhost:8888/' });
      // Verify via checkStatus call URL
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ started: '2024-01-01' }),
      });
      client.checkStatus();
      expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost:8888/api/status', expect.any(Object));
    });
  });

  describe('request methods', () => {
    let client: JupyterBrowserClient;

    beforeEach(() => {
      client = new JupyterBrowserClient({ serverUrl: 'http://localhost:8888', token: 'test-token' });
    });

    it('checkStatus sends GET /api/status with auth header', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ started: '2024-01-01', last_activity: '2024-01-01' }),
      });

      const result = await client.checkStatus();
      expect(result.started).toBe('2024-01-01');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:8888/api/status',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'token test-token' }),
        })
      );
    });

    it('startSession sends POST /api/sessions', async () => {
      const mockSession = { id: 's1', path: 'test.ipynb', kernel: { id: 'k1' } };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockSession),
      });

      const result = await client.startSession('test.ipynb', 'python3');
      expect(result.id).toBe('s1');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:8888/api/sessions',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('stopSession sends DELETE /api/sessions/:id', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });

      await client.stopSession('s1');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:8888/api/sessions/s1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('deleteContents sends DELETE /api/contents/:path', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });

      await client.deleteContents('b4m-notebook-123.ipynb');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:8888/api/contents/b4m-notebook-123.ipynb',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('throws JupyterBrowserError on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: () => Promise.resolve({ message: 'Forbidden' }),
      });

      await expect(client.checkStatus()).rejects.toThrow(JupyterBrowserError);
    });
  });

  describe('getKernelWebSocketUrl', () => {
    it('URL-encodes the token in the query string', async () => {
      const client = new JupyterBrowserClient({ serverUrl: 'http://localhost:8888', token: 'a+b=c&d' });

      // Trigger executeCell to capture the WebSocket URL
      const cellPromise = client.executeCell('kernel-1', 'print("hi")', 1000);

      // Wait for the mock WS to be created
      await new Promise(r => setTimeout(r, 10));
      expect(mockWsInstance).not.toBeNull();
      expect(mockWsInstance!.url).toBe('ws://localhost:8888/api/kernels/kernel-1/channels?token=a%2Bb%3Dc%26d');

      // Clean up: simulate close to reject the promise
      mockWsInstance!.simulateClose();
      await expect(cellPromise).rejects.toThrow();
    });
  });

  describe('executeCell', () => {
    let client: JupyterBrowserClient;

    beforeEach(() => {
      client = new JupyterBrowserClient({ serverUrl: 'http://localhost:8888' });
    });

    it('resolves on successful execute_reply', async () => {
      const cellPromise = client.executeCell('k1', 'print("hello")', 5000);

      await new Promise(r => setTimeout(r, 10));
      expect(mockWsInstance).not.toBeNull();

      // Get the msg_id from the sent message
      expect(mockWsInstance!.sentMessages.length).toBe(1);
      const sentMsg = JSON.parse(mockWsInstance!.sentMessages[0]);
      const msgId = sentMsg.header.msg_id;

      // Simulate stream output
      mockWsInstance!.simulateMessage({
        parent_header: { msg_id: msgId },
        header: { msg_type: 'stream' },
        content: { name: 'stdout', text: 'hello\n' },
      });

      // Simulate execute_reply
      mockWsInstance!.simulateMessage({
        parent_header: { msg_id: msgId },
        header: { msg_type: 'execute_reply' },
        content: { status: 'ok', execution_count: 1 },
      });

      const result = await cellPromise;
      expect(result.success).toBe(true);
      expect(result.executionCount).toBe(1);
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0].output_type).toBe('stream');
    });

    it('resolves with error info on execution error', async () => {
      const cellPromise = client.executeCell('k1', 'raise ValueError("bad")', 5000);

      await new Promise(r => setTimeout(r, 10));
      const sentMsg = JSON.parse(mockWsInstance!.sentMessages[0]);
      const msgId = sentMsg.header.msg_id;

      mockWsInstance!.simulateMessage({
        parent_header: { msg_id: msgId },
        header: { msg_type: 'error' },
        content: { ename: 'ValueError', evalue: 'bad', traceback: ['line 1'] },
      });

      mockWsInstance!.simulateMessage({
        parent_header: { msg_id: msgId },
        header: { msg_type: 'execute_reply' },
        content: { status: 'error', execution_count: 1 },
      });

      const result = await cellPromise;
      expect(result.success).toBe(false);
      expect(result.error?.ename).toBe('ValueError');
      expect(result.error?.evalue).toBe('bad');
    });

    it('rejects when WebSocket closes before execute_reply', async () => {
      const cellPromise = client.executeCell('k1', 'print("hi")', 5000);

      await new Promise(r => setTimeout(r, 10));

      // Close without sending execute_reply
      mockWsInstance!.simulateClose();

      await expect(cellPromise).rejects.toThrow('WebSocket closed before execution completed');
    });

    it('rejects on timeout', async () => {
      const cellPromise = client.executeCell('k1', 'import time; time.sleep(999)', 50);

      await expect(cellPromise).rejects.toThrow('timed out after 50ms');
    });

    it('rejects on WebSocket error', async () => {
      const cellPromise = client.executeCell('k1', 'print("hi")', 5000);

      await new Promise(r => setTimeout(r, 10));
      mockWsInstance!.simulateError();

      await expect(cellPromise).rejects.toThrow('WebSocket connection failed');
    });

    it('ignores messages from other requests', async () => {
      const cellPromise = client.executeCell('k1', 'x = 1', 5000);

      await new Promise(r => setTimeout(r, 10));
      const sentMsg = JSON.parse(mockWsInstance!.sentMessages[0]);
      const msgId = sentMsg.header.msg_id;

      // Message from a different request
      mockWsInstance!.simulateMessage({
        parent_header: { msg_id: 'other-msg-id' },
        header: { msg_type: 'stream' },
        content: { name: 'stdout', text: 'wrong' },
      });

      // Our execute_reply
      mockWsInstance!.simulateMessage({
        parent_header: { msg_id: msgId },
        header: { msg_type: 'execute_reply' },
        content: { status: 'ok', execution_count: 1 },
      });

      const result = await cellPromise;
      expect(result.outputs).toHaveLength(0);
    });

    it('warns on binary frames instead of crashing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cellPromise = client.executeCell('k1', 'x = 1', 5000);

      await new Promise(r => setTimeout(r, 10));
      const sentMsg = JSON.parse(mockWsInstance!.sentMessages[0]);
      const msgId = sentMsg.header.msg_id;

      // Simulate a binary frame (non-string data)
      mockWsInstance!.onmessage?.({ data: new ArrayBuffer(8) as unknown as string });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('binary WebSocket frame'));

      // Complete normally
      mockWsInstance!.simulateMessage({
        parent_header: { msg_id: msgId },
        header: { msg_type: 'execute_reply' },
        content: { status: 'ok', execution_count: 1 },
      });

      const result = await cellPromise;
      expect(result.success).toBe(true);
      warnSpy.mockRestore();
    });
  });
});

describe('localStorage config helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns null when no config stored', () => {
    expect(getStoredJupyterConfig()).toBeNull();
  });

  it('round-trips config through set/get', () => {
    setStoredJupyterConfig({ serverUrl: 'http://localhost:8888', token: 'abc' });
    const config = getStoredJupyterConfig();
    expect(config).toEqual({ serverUrl: 'http://localhost:8888', token: 'abc' });
  });

  it('clears config', () => {
    setStoredJupyterConfig({ serverUrl: 'http://localhost:8888', token: '' });
    clearStoredJupyterConfig();
    expect(getStoredJupyterConfig()).toBeNull();
  });

  it('returns null for corrupted JSON', () => {
    localStorage.setItem('b4m-jupyter-config', 'not-json');
    expect(getStoredJupyterConfig()).toBeNull();
  });

  it('returns null for object missing serverUrl', () => {
    localStorage.setItem('b4m-jupyter-config', JSON.stringify({ token: 'abc' }));
    expect(getStoredJupyterConfig()).toBeNull();
  });
});
