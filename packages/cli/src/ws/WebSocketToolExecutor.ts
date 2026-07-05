import { WebSocketConnectionManager } from './WebSocketConnectionManager';
import { v4 as uuidv4 } from 'uuid';

interface ToolResult {
  success: boolean;
  content?: unknown;
  error?: string;
}

/**
 * Executes CLI tools via WebSocket (request-response pattern).
 * Bypasses CloudFront 20s timeout for long-running tool operations.
 */
export class WebSocketToolExecutor {
  private wsManager: WebSocketConnectionManager;
  private tokenGetter: () => Promise<string | null>;

  constructor(wsManager: WebSocketConnectionManager, tokenGetter: () => Promise<string | null>) {
    this.wsManager = wsManager;
    this.tokenGetter = tokenGetter;
  }

  /**
   * Execute a server-side tool via WebSocket.
   * Returns the tool result or throws on error.
   */
  async execute(toolName: string, input: Record<string, unknown>, abortSignal?: AbortSignal): Promise<ToolResult> {
    if (!this.wsManager.isConnected) {
      throw new Error('WebSocket is not connected');
    }

    const token = await this.tokenGetter();
    if (!token) {
      throw new Error('No access token available');
    }

    const requestId = uuidv4();

    return new Promise<ToolResult>((resolve, reject) => {
      let settled = false;
      // eslint-disable-next-line prefer-const -- reassigned inside setTimeout callback below
      let timeoutTimer: ReturnType<typeof setTimeout>;

      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        this.wsManager.offRequest(requestId);
        this.wsManager.offDisconnect(onDisconnect);
        abortSignal?.removeEventListener('abort', abortHandler);
        action();
      };

      const settleResolve = (result: ToolResult): void => settle(() => resolve(result));
      const settleReject = (err: Error): void => settle(() => reject(err));

      // Client-side timeout - reject if server doesn't respond within 5 minutes
      const TOOL_TIMEOUT_MS = 5 * 60 * 1000;
      timeoutTimer = setTimeout(() => {
        settleReject(new Error(`Tool execution timed out after ${TOOL_TIMEOUT_MS / 1000}s`));
      }, TOOL_TIMEOUT_MS);

      // Handle connection drop
      const onDisconnect = (): void => {
        settleReject(new Error('WebSocket connection lost during tool execution'));
      };
      this.wsManager.onDisconnect(onDisconnect);

      // Handle abort signal
      const abortHandler = (): void => {
        settleReject(new Error('Tool execution aborted'));
      };
      if (abortSignal) {
        if (abortSignal.aborted) {
          settleReject(new Error('Tool execution aborted'));
          return;
        }
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      // Register handler for this request
      this.wsManager.onRequest(requestId, message => {
        if ((message.action as string) === 'cli_tool_response') {
          settleResolve({
            success: message.success as boolean,
            content: message.content,
            error: message.error as string | undefined,
          });
        }
      });

      // Send tool request
      try {
        this.wsManager.send({
          action: 'cli_tool_request',
          accessToken: token,
          requestId,
          toolName,
          input,
        });
      } catch (err) {
        settleReject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
