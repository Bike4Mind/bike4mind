/**
 * Browser-side Jupyter Server Client
 *
 * Connects directly to a user's local Jupyter server from the browser,
 * eliminating the need for the CLI as a middleman.
 *
 * Uses browser-native fetch() and WebSocket APIs.
 * Requires the Jupyter server to allow cross-origin requests:
 *   jupyter lab --ServerApp.allow_origin='*'
 *
 * @see https://jupyter-server.readthedocs.io/en/latest/developers/rest-api.html
 * @see https://jupyter-client.readthedocs.io/en/latest/messaging.html
 */

import { validateNotebookPath as validateNotebookPathBase, validateJupyterKernelName } from '@bike4mind/common';

export interface JupyterBrowserConfig {
  serverUrl: string;
  token?: string;
}

export interface JupyterSession {
  id: string;
  path: string;
  name: string;
  type: string;
  kernel: {
    id: string;
    name: string;
    last_activity: string;
    execution_state: string;
    connections: number;
  };
}

export interface CellOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface ExecuteCellResult {
  success: boolean;
  outputs: CellOutput[];
  executionCount: number | null;
  error?: {
    ename: string;
    evalue: string;
    traceback: string[];
  };
}

export class JupyterBrowserError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'JupyterBrowserError';
  }
}

function validateServerUrl(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new JupyterBrowserError('Server URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JupyterBrowserError(`Invalid server URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new JupyterBrowserError(`Invalid protocol: ${parsed.protocol}. Only http and https are allowed`);
  }
}

function validateNotebookPath(path: string): void {
  const result = validateNotebookPathBase(path);
  if (!result.valid) {
    throw new JupyterBrowserError(result.error || 'Invalid notebook path');
  }
}

function validateKernelName(name: string): void {
  const result = validateJupyterKernelName(name);
  if (!result.valid) {
    throw new JupyterBrowserError(result.error || 'Invalid kernel name');
  }
}

export class JupyterBrowserClient {
  private serverUrl: string;
  private token?: string;

  constructor(config: JupyterBrowserConfig) {
    validateServerUrl(config.serverUrl);
    this.serverUrl = config.serverUrl.replace(/\/$/, '');
    this.token = config.token;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `token ${this.token}`;
    }
    return headers;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: this.getHeaders(),
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new JupyterBrowserError(
        `Jupyter API error: ${response.status} ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async checkStatus(): Promise<{ started: string; last_activity: string }> {
    return this.request('GET', '/api/status');
  }

  async getKernelSpecs(): Promise<{
    default: string;
    kernelspecs: Record<string, { name: string; spec: { display_name: string; language: string } }>;
  }> {
    return this.request('GET', '/api/kernelspecs');
  }

  async startSession(notebookPath: string, kernelName?: string): Promise<JupyterSession> {
    validateNotebookPath(notebookPath);
    const kernel = kernelName || 'python3';
    validateKernelName(kernel);

    return this.request('POST', '/api/sessions', {
      path: notebookPath,
      type: 'notebook',
      name: notebookPath.split('/').pop() || 'Untitled',
      kernel: { name: kernel },
    });
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/api/sessions/${sessionId}`);
  }

  private getKernelWebSocketUrl(kernelId: string): string {
    const httpUrl = new URL(this.serverUrl);
    const wsProtocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${httpUrl.host}/api/kernels/${kernelId}/channels`;
    if (this.token) {
      return `${wsUrl}?token=${this.token}`;
    }
    return wsUrl;
  }

  private generateMsgId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  async executeCell(kernelId: string, code: string, timeoutMs = 30000): Promise<ExecuteCellResult> {
    const wsUrl = this.getKernelWebSocketUrl(kernelId);
    const msgId = this.generateMsgId();

    return new Promise((resolve, reject) => {
      const outputs: CellOutput[] = [];
      let executionCount: number | null = null;
      let hasError = false;
      let errorInfo: { ename: string; evalue: string; traceback: string[] } | undefined;

      const ws = new WebSocket(wsUrl);
      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new JupyterBrowserError(`Cell execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };

      ws.onerror = () => {
        cleanup();
        reject(
          new JupyterBrowserError('WebSocket connection failed. Is the Jupyter server running with CORS enabled?')
        );
      };

      ws.onopen = () => {
        const executeRequest = {
          header: {
            msg_id: msgId,
            msg_type: 'execute_request',
            username: 'b4m-browser',
            session: this.generateMsgId(),
            date: new Date().toISOString(),
            version: '5.3',
          },
          parent_header: {},
          metadata: {},
          content: {
            code,
            silent: false,
            store_history: true,
            user_expressions: {},
            allow_stdin: false,
            stop_on_error: true,
          },
          buffers: [],
          channel: 'shell',
        };

        ws.send(JSON.stringify(executeRequest));
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');

          if (msg.parent_header?.msg_id !== msgId) return;

          const msgType = msg.header?.msg_type || msg.msg_type;

          switch (msgType) {
            case 'stream':
              outputs.push({
                output_type: 'stream',
                name: msg.content.name,
                text: msg.content.text,
              });
              break;

            case 'execute_result':
              executionCount = msg.content.execution_count;
              outputs.push({
                output_type: 'execute_result',
                data: msg.content.data,
                execution_count: msg.content.execution_count,
                metadata: msg.content.metadata,
              });
              break;

            case 'display_data':
              outputs.push({
                output_type: 'display_data',
                data: msg.content.data,
                metadata: msg.content.metadata,
              });
              break;

            case 'error':
              hasError = true;
              errorInfo = {
                ename: msg.content.ename,
                evalue: msg.content.evalue,
                traceback: msg.content.traceback,
              };
              outputs.push({
                output_type: 'error',
                ename: msg.content.ename,
                evalue: msg.content.evalue,
                traceback: msg.content.traceback,
              });
              break;

            case 'execute_reply':
              if (msg.content.status === 'ok' || msg.content.status === 'error') {
                if (msg.content.execution_count !== undefined) {
                  executionCount = msg.content.execution_count;
                }
                cleanup();
                resolve({
                  success: !hasError,
                  outputs,
                  executionCount,
                  error: errorInfo,
                });
              }
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        clearTimeout(timeoutHandle);
      };
    });
  }
}

// -- Jupyter config persistence (localStorage) --

const JUPYTER_CONFIG_KEY = 'b4m-jupyter-config';

export interface StoredJupyterConfig {
  serverUrl: string;
  token: string;
}

export function getStoredJupyterConfig(): StoredJupyterConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(JUPYTER_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.serverUrl) return parsed as StoredJupyterConfig;
    return null;
  } catch {
    return null;
  }
}

export function setStoredJupyterConfig(config: StoredJupyterConfig): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(JUPYTER_CONFIG_KEY, JSON.stringify(config));
}

export function clearStoredJupyterConfig(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(JUPYTER_CONFIG_KEY);
}
