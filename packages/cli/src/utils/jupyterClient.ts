/**
 * Jupyter Server REST API Client
 *
 * Provides methods for interacting with a local Jupyter Server instance.
 * Used by Keep commands to execute notebooks on the user's local machine.
 *
 * @see https://jupyter-server.readthedocs.io/en/latest/developers/rest-api.html
 * @see https://jupyter-client.readthedocs.io/en/latest/messaging.html
 */

import WebSocket from 'ws';
import { validateNotebookPath as validateNotebookPathBase, validateJupyterKernelName } from '@bike4mind/common';

export interface JupyterConfig {
  serverUrl: string;
  token?: string;
}

export interface KernelSpec {
  name: string;
  spec: {
    display_name: string;
    language: string;
    argv: string[];
  };
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
  name?: string; // stdout, stderr for stream outputs
  text?: string | string[];
  data?: Record<string, unknown>; // MIME type -> data for rich outputs
  metadata?: Record<string, unknown>; // Output metadata
  execution_count?: number | null;
  ename?: string; // Error name
  evalue?: string; // Error value
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

export class JupyterClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'JupyterClientError';
  }
}

/**
 * Validate Jupyter server URL
 */
function validateServerUrl(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new JupyterClientError('Server URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JupyterClientError(`Invalid server URL: ${url}`);
  }

  // Only allow http and https protocols
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new JupyterClientError(`Invalid protocol: ${parsed.protocol}. Only http and https are allowed`);
  }

  // No localhost/internal-IP block here: in a CLI, localhost is the expected target.
}

/**
 * Validate notebook path to prevent path traversal (throws on invalid)
 */
function validateNotebookPath(path: string): void {
  const result = validateNotebookPathBase(path);
  if (!result.valid) {
    throw new JupyterClientError(result.error || 'Invalid notebook path');
  }
}

/**
 * Validate kernel name against whitelist (throws on invalid)
 */
function validateKernelName(name: string): void {
  const result = validateJupyterKernelName(name);
  if (!result.valid) {
    throw new JupyterClientError(result.error || 'Invalid kernel name');
  }
}

export class JupyterClient {
  private serverUrl: string;
  private token?: string;

  constructor(config: JupyterConfig) {
    // Validate and normalize URL
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
      throw new JupyterClientError(
        `Jupyter API error: ${response.status} ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    // Handle empty responses (204 No Content)
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Check if the Jupyter server is running and accessible
   */
  async checkStatus(): Promise<{ started: string; last_activity: string }> {
    return this.request('GET', '/api/status');
  }

  /**
   * Get available kernel specifications
   */
  async getKernelSpecs(): Promise<{
    default: string;
    kernelspecs: Record<string, KernelSpec>;
  }> {
    return this.request('GET', '/api/kernelspecs');
  }

  /**
   * List all active sessions
   */
  async listSessions(): Promise<JupyterSession[]> {
    return this.request('GET', '/api/sessions');
  }

  /**
   * Start a new kernel session for a notebook
   */
  async startSession(notebookPath: string, kernelName?: string): Promise<JupyterSession> {
    // Validate inputs
    validateNotebookPath(notebookPath);
    const kernel = kernelName || 'python3';
    validateKernelName(kernel);

    return this.request('POST', '/api/sessions', {
      path: notebookPath,
      type: 'notebook',
      name: notebookPath.split('/').pop() || 'Untitled',
      kernel: {
        name: kernel,
      },
    });
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<JupyterSession> {
    return this.request('GET', `/api/sessions/${sessionId}`);
  }

  /**
   * Stop a kernel session
   */
  async stopSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/api/sessions/${sessionId}`);
  }

  /**
   * Get WebSocket URL for kernel channels
   */
  private getKernelWebSocketUrl(kernelId: string): string {
    const httpUrl = new URL(this.serverUrl);
    const wsProtocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${httpUrl.host}/api/kernels/${kernelId}/channels`;
    if (this.token) {
      return `${wsUrl}?token=${this.token}`;
    }
    return wsUrl;
  }

  /**
   * Generate a unique message ID for Jupyter protocol
   */
  private generateMsgId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Execute code in a kernel using the Jupyter WebSocket protocol.
   *
   * Connects to the kernel's channels WebSocket, sends an execute_request,
   * and collects outputs until the kernel returns to idle state.
   *
   * @param kernelId - The kernel ID to execute code in
   * @param code - The code to execute
   * @param timeoutMs - Execution timeout in milliseconds (default: 30000)
   */
  async executeCell(kernelId: string, code: string, timeoutMs = 30000): Promise<ExecuteCellResult> {
    const wsUrl = this.getKernelWebSocketUrl(kernelId);
    const msgId = this.generateMsgId();

    return new Promise((resolve, reject) => {
      const outputs: CellOutput[] = [];
      let executionCount: number | null = null;
      let hasError = false;
      let errorInfo: { ename: string; evalue: string; traceback: string[] } | undefined;

      const ws = new WebSocket(wsUrl);
      const timeoutHandle: NodeJS.Timeout = setTimeout(() => {
        cleanup();
        reject(new JupyterClientError(`Cell execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };

      ws.on('error', (err: Error) => {
        cleanup();
        reject(new JupyterClientError(`WebSocket error: ${err.message}`));
      });

      ws.on('open', () => {
        // Send execute_request message on shell channel
        const executeRequest = {
          header: {
            msg_id: msgId,
            msg_type: 'execute_request',
            username: 'b4m-cli',
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
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Only process messages related to our request
          if (msg.parent_header?.msg_id !== msgId) {
            return;
          }

          const msgType = msg.header?.msg_type || msg.msg_type;

          switch (msgType) {
            case 'stream':
              // stdout/stderr output
              outputs.push({
                output_type: 'stream',
                name: msg.content.name,
                text: msg.content.text,
              });
              break;

            case 'execute_result':
              // Rich output from expression evaluation
              executionCount = msg.content.execution_count;
              outputs.push({
                output_type: 'execute_result',
                data: msg.content.data,
                execution_count: msg.content.execution_count,
                metadata: msg.content.metadata,
              });
              break;

            case 'display_data':
              // Rich display output (plots, images, etc.)
              outputs.push({
                output_type: 'display_data',
                data: msg.content.data,
                metadata: msg.content.metadata,
              });
              break;

            case 'error':
              // Execution error
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
              // Execution complete - check status and resolve
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

            case 'status':
              // Kernel status update - we primarily use execute_reply for completion
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        // If we haven't resolved yet, the connection was closed unexpectedly
        clearTimeout(timeoutHandle);
      });
    });
  }

  /**
   * @deprecated Use executeCell instead. This method exists for backwards compatibility.
   */
  async executeCode(kernelId: string, code: string): Promise<ExecuteCellResult> {
    return this.executeCell(kernelId, code);
  }

  /**
   * Interrupt a running kernel
   */
  async interruptKernel(kernelId: string): Promise<void> {
    await this.request('POST', `/api/kernels/${kernelId}/interrupt`);
  }

  /**
   * Restart a kernel
   */
  async restartKernel(kernelId: string): Promise<{ id: string; name: string }> {
    return this.request('POST', `/api/kernels/${kernelId}/restart`);
  }
}

/**
 * Create a JupyterClient from environment variables or config
 */
export function createJupyterClientFromEnv(): JupyterClient | null {
  const serverUrl = process.env.JUPYTER_SERVER_URL;
  const token = process.env.JUPYTER_TOKEN;

  if (!serverUrl) {
    return null;
  }

  return new JupyterClient({ serverUrl, token });
}
