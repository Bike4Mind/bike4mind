/**
 * `b4m mcp serve` - expose Bike4Mind as an MCP server.
 *
 * Two transports: stdio (default, for Claude Desktop and other local clients)
 * and stateless streamable HTTP (`--http`). Auth precedence is
 * `--api-key` > `B4M_API_KEY` > the stored OAuth JWT; the endpoint is
 * `B4M_API_URL` > `--api-url` > the CLI's configured backend.
 *
 * Transport contract for stdio: stdout carries the JSON-RPC frame stream and
 * NOTHING else, so all diagnostics are forced to stderr before ANY other work
 * runs (mirrors the acp command's captureStdout - see src/commands/acpCommand.ts).
 *
 * HTTP mode is deliberately loopback-only (binds 127.0.0.1) with no per-request
 * auth of its own - it trusts anything that can reach the socket, so it must not
 * be exposed on a routable interface. DNS-rebinding protection is on as defense
 * in depth against a browser being tricked into posting to the local port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import { parseApiUrl, requireApiUrl } from '../utils/apiUrl.js';
import { buildMcpServer, type BuildServerOptions } from './server.js';
import { logger } from '../utils/Logger.js';

const HTTP_PATH = '/mcp';

export interface ServeOptions {
  http?: boolean;
  port?: number;
  apiKey?: string;
  apiUrl?: string;
  /** CLI version, reported to the client as the server's `version`. */
  version: string;
}

/** Writes a chunk to the real stdout; returns false when backpressured. */
type FrameWriter = (chunk: Uint8Array) => boolean;

/**
 * Capture the real stdout for the JSON-RPC frame stream, then redirect
 * everything else - `console.*` and any stray `process.stdout.write` deep in the
 * stack - to stderr. A single unrelated byte on stdout corrupts a frame, so the
 * whole channel is closed rather than trusting no dependency ever prints.
 */
function captureStdout(): FrameWriter {
  const writeToRealStdout = process.stdout.write.bind(process.stdout) as FrameWriter;

  const toStderr = (...args: unknown[]) => {
    process.stderr.write(args.map(String).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    process.stderr.write(chunk as string);
    return true;
  }) as typeof process.stdout.write;

  return writeToRealStdout;
}

function resolveBaseURL(options: ServeOptions, configStore: ConfigStore): Promise<string> {
  const explicit = process.env.B4M_API_URL ?? options.apiUrl;
  if (explicit) {
    const parsed = parseApiUrl(explicit);
    if ('error' in parsed) {
      throw new Error(`Invalid API URL: ${parsed.error}`);
    }
    return Promise.resolve(parsed.url);
  }
  return configStore.getApiConfig().then(apiConfig => requireApiUrl(apiConfig));
}

async function serveStdio(buildOptions: BuildServerOptions, writeFrame: FrameWriter): Promise<void> {
  const server = buildMcpServer(buildOptions);

  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (writeFrame(chunk)) {
        callback();
        return;
      }
      process.stdout.once('drain', () => callback());
    },
  });

  const transport = new StdioServerTransport(process.stdin, stdout);
  await server.connect(transport);

  // Run until the client closes stdin.
  await new Promise<void>(resolve => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  buildOptions: BuildServerOptions,
  port: number
): Promise<void> {
  // Stateless: a fresh server + transport per request so concurrent clients can
  // never observe each other's in-flight request state. DNS-rebinding protection
  // rejects requests whose Host header is not our loopback origin.
  const server = buildMcpServer(buildOptions);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

async function serveHttp(buildOptions: BuildServerOptions, port: number): Promise<void> {
  const httpServer = createServer((req, res) => {
    // Only the documented endpoint is served; everything else is a 404.
    const pathname = new URL(req.url ?? '/', `http://localhost:${port}`).pathname;
    if (pathname !== HTTP_PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${HTTP_PATH}.` }));
      return;
    }

    handleHttpRequest(req, res, buildOptions, port).catch(err => {
      logger.error('MCP HTTP request failed', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
        );
      }
    });
  });

  // Bind loopback only: this transport has no per-request auth, so it must never
  // be reachable off the local host.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });

  // stderr, not stdout: keep parity with stdio mode and any log-scraping wrapper.
  process.stderr.write(`Bike4Mind MCP server listening on http://127.0.0.1:${port}${HTTP_PATH}\n`);

  // Run until the process is killed.
  await new Promise<void>(() => {});
}

export async function handleMcpServeCommand(options: ServeOptions): Promise<void> {
  // stdio mode: seize stdout for the frame stream BEFORE anything else can print
  // to it (ConfigStore load, endpoint resolution, ...). HTTP mode leaves stdout
  // alone since its frames travel over the socket.
  const writeFrame = options.http ? undefined : captureStdout();

  const configStore = new ConfigStore();
  const baseURL = await resolveBaseURL(options, configStore);
  const apiKey = options.apiKey ?? process.env.B4M_API_KEY;

  const buildOptions: BuildServerOptions = { baseURL, apiKey, configStore, version: options.version };

  if (writeFrame) {
    await serveStdio(buildOptions, writeFrame);
  } else {
    await serveHttp(buildOptions, options.port ?? 7000);
  }
}
