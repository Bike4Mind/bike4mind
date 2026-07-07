/**
 * `b4m acp` - run the agent as an Agent Client Protocol (ACP) server.
 *
 * ACP is "LSP for coding agents": JSON-RPC 2.0 over stdio. This turns the CLI
 * into a first-class agent backend for any ACP-capable editor (Zed today) with
 * no per-editor extension work. It sits parallel to the interactive TUI and the
 * headless stream-json mode, reusing the same agent core, permission model, and
 * session store.
 *
 * Transport contract: stdout carries the JSON-RPC stream and NOTHING else, so
 * all diagnostics are forced to stderr before the agent stack (which logs
 * freely) boots.
 */

import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '../acp/acpSdk.js';
import { AcpServer } from '../acp/AcpServer.js';
import { buildAcpApp } from '../acp/app.js';
import { logger } from '../utils/Logger';

export interface AcpOptions {
  verbose: boolean;
  /** CLI version, reported to the client as `agentInfo.version`. */
  version: string;
}

/**
 * Redirect stdout-bound console output (and stray prints from deep in the
 * stack) to stderr so they cannot corrupt the JSON-RPC frame stream.
 */
function guardStdout(): void {
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(args.map(String).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

export async function handleAcpCommand(options: AcpOptions): Promise<void> {
  guardStdout();
  logger.setVerbose(options.verbose);

  // process.stdin/stdout are Node streams; the SDK consumes web streams.
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  // Handlers close over `server`, which is assigned right after connect().
  // connect() returns synchronously and inbound requests only arrive on a later
  // tick, so `server` is always set by the time a handler runs; guardServer()
  // makes that invariant explicit.
  let server: AcpServer | null = null;
  const guardServer = (): AcpServer => {
    if (!server) throw new Error('ACP server accessed before connection established');
    return server;
  };

  const app = buildAcpApp(guardServer);

  const connection = app.connect(stream);
  server = new AcpServer(connection.signal, options.version);

  await connection.closed;
  await server.close();
}
