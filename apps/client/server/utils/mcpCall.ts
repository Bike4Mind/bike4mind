import { MCPClient } from '@bike4mind/mcp';
import { Resource } from 'sst';

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMessage)), timeoutMs)),
  ]);
};

export const handler = async (params: any) => {
  const { envVariables, name, toolName, toolArgs, action } = params;

  // Capture rate limit events from the MCP server's stderr stream.
  // All rate limit logging uses console.error in the child process (stderr),
  // because MCP uses stdout for JSON-RPC protocol.
  const rateLimitEvents: Record<string, unknown>[] = [];
  const mcp = new MCPClient({
    envVariables,
    name,
    onStderrLine: (line: string) => {
      if (line.includes('"type":"RATE_LIMIT')) {
        try {
          rateLimitEvents.push(JSON.parse(line));
        } catch {
          /* ignore parse errors */
        }
      }
    },
  });

  let isConnected = false;
  const TIMEOUT_MS = 30000;
  const MAX_RETRIES = 2;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let payload = {};

      await withTimeout(mcp.connectToServer(), TIMEOUT_MS, `MCP connection timeout for ${name} after ${TIMEOUT_MS}ms`);
      isConnected = true;

      if (action === 'getTools') {
        const tools = mcp.tools;
        if (Array.isArray(tools)) {
          payload = tools;
        } else {
          console.error(`❌ MCP Handler: Tools is not an array for ${name}:`, tools);
          payload = [];
        }
      } else if (action === 'callTool') {
        if (!toolName) {
          throw new Error('toolName is required when calling a MCP tool');
        }

        // Call tool with timeout (rate limit events captured via onStderrLine callback)
        const result = await withTimeout(
          mcp.callTool(toolName, toolArgs),
          TIMEOUT_MS,
          `MCP tool call timeout for ${toolName} on ${name} after ${TIMEOUT_MS}ms`
        );

        payload = result;
      } else {
        throw new Error(`Invalid action: ${action}`);
      }
      console.log(`✅ MCP Handler: ${action} completed successfully for ${name}`);

      // Child process's stderr stream may still have buffered data events queued in the event
      // loop after callTool() resolves. Yielding a tick flushes those callbacks so
      // rateLimitEvents is fully populated. MCPClient exposes no drain promise for the stream
      // 'end' event, so this is a pragmatic workaround.
      await new Promise(resolve => setTimeout(resolve, 50));

      // Persist rate limit events via Next.js API (Lambda has no direct MongoDB access).
      // APP_URL is set by infra/mcp.ts (router.url) in deployed environments;
      // falls back to localhost for SST dev (local development) only.
      if (rateLimitEvents.length > 0) {
        const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
        const ingestUrl = `${baseUrl}/api/admin/rate-limits/ingest`;
        const ingestToken = Resource.RATE_LIMIT_INGEST_TOKEN?.value || process.env.RATE_LIMIT_INGEST_TOKEN;
        try {
          const resp = await fetch(ingestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(ingestToken && { 'x-rate-limit-ingest-token': ingestToken }),
            },
            body: JSON.stringify({ events: rateLimitEvents }),
          });
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => 'no body')}`);
          }
          const result = await resp.json();
          console.log(`[RateLimit] Persisted ${result.persisted}/${rateLimitEvents.length} events for ${name}`);
        } catch (err) {
          console.error(`[RateLimit] Failed to persist events for ${name}:`, err);
          // Fallback: attach events to payload for upstream persistence via invokeMcpHandler
          payload = { ...payload, _rateLimitEvents: rateLimitEvents };
        }
      }

      return payload;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isConnectionError =
        lastError.message.includes('Connection closed') ||
        lastError.message.includes('-32000') ||
        lastError.message.includes('EPIPE') ||
        lastError.message.includes('ECONNRESET');

      if (isConnectionError && attempt < MAX_RETRIES) {
        console.warn(`⚠️ MCP Handler: Connection error on attempt ${attempt}/${MAX_RETRIES} for ${name}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }

      const errorMessage = lastError.message;
      const enhancedError = new Error(`MCP Handler failed for ${name} (action: ${action}): ${errorMessage}`);
      console.error(`❌ MCP Handler Error for ${name}:`, enhancedError);
      throw enhancedError;
    } finally {
      if (isConnected) {
        try {
          await withTimeout(mcp.disconnect(), 5000, `MCP disconnect timeout for ${name}`);
        } catch (disconnectError) {
          // Disconnect errors aren't critical - log and continue
          console.warn(`⚠️ MCP Handler: Error disconnecting from ${name}:`, disconnectError);
        }
        isConnected = false;
      }
    }
  }

  if (lastError) {
    throw new Error(`MCP Handler failed for ${name} after ${MAX_RETRIES} attempts: ${lastError.message}`);
  }
};
