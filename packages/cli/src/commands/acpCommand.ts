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

import { Readable } from 'node:stream';
import { ndJsonStream } from '../acp/acpSdk.js';
import { AcpServer } from '../acp/AcpServer.js';
import { buildAcpApp } from '../acp/app.js';
import { logger } from '../utils/Logger';

export interface AcpOptions {
  verbose: boolean;
  /** CLI version, reported to the client as `agentInfo.version`. */
  version: string;
}

/** Writes a chunk to the real stdout; returns false when backpressured. */
type FrameWriter = (chunk: Uint8Array) => boolean;

/**
 * Isolate stdout for the JSON-RPC frame stream. Returns a writer bound to the
 * REAL stdout for the protocol to use, then redirects everything else -
 * `console.*` AND any stray `process.stdout.write` deep in the agent stack - to
 * stderr. stdout purity is the one invariant this transport must hold: a single
 * unrelated byte on stdout corrupts a frame, so we close the whole channel
 * rather than trusting no dependency ever prints.
 */
function captureStdout(): FrameWriter {
  const writeToRealStdout = process.stdout.write.bind(process.stdout) as FrameWriter;

  const toStderr = (...args: unknown[]) => {
    process.stderr.write(args.map(String).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  // Redirect direct stdout writes (bypassing console) to stderr. The protocol
  // uses the captured `writeToRealStdout` above, so frames are unaffected.
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    process.stderr.write(chunk as string);
    return true;
  }) as typeof process.stdout.write;

  return writeToRealStdout;
}

export async function handleAcpCommand(options: AcpOptions): Promise<void> {
  const writeFrame = captureStdout();
  logger.setVerbose(options.verbose);

  // process.stdin is a Node stream; the SDK consumes web streams. Output goes
  // through the captured real-stdout writer (see captureStdout) so it survives
  // the process.stdout.write redirect, honoring backpressure via 'drain'.
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      if (writeFrame(chunk)) return;
      return new Promise<void>(resolve => process.stdout.once('drain', resolve));
    },
  });
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
