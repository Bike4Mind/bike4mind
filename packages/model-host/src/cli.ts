import { parseArgs, type ParseArgsConfig } from 'node:util';
import { DEFAULT_OLLAMA_URL } from '@bike4mind/local-models';
import { dialFirst, dialStdio, exitCodeFor, fetchHello } from './dial';
import { dialCandidates } from './paths';
import { serve } from './serve';
import { HOST_VERSION } from './version';

export interface HostIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** How help text names the command: `b4m-host`, or `b4m host` from the CLI. */
  programName: string;
  /** Aborted to stop `serve`; defaults to SIGINT and SIGTERM. */
  signal?: AbortSignal;
}

const EXIT_USAGE = 2;

function usage(program: string): string {
  return `Usage: ${program} <command> [options]

Commands:
  serve               Run the host (a service manager runs this)
  dial-stdio          Connect stdin and stdout to the host's socket (Bike4Mind runs this over SSH)
  status              Show whether the host is running and what it reports
  version             Print the version

Options:
  --user              serve: run for this user only, with one socket only this user can open
  --socket-dir <dir>  Socket directory (default /run/b4m-host; with --user, $XDG_RUNTIME_DIR/b4m-host)
  --state-dir <dir>   serve: state directory (default /var/lib/b4m-host; with --user, ~/.local/state/b4m-host)
  --ollama-url <url>  serve: the Ollama on this machine (default ${DEFAULT_OLLAMA_URL})
  --json              status: print JSON

Exit codes: 3 the host is not running, 4 no permission to open its socket.
`;
}

const OPTIONS = {
  serve: {
    user: { type: 'boolean' },
    'socket-dir': { type: 'string' },
    'state-dir': { type: 'string' },
    'ollama-url': { type: 'string' },
  },
  'dial-stdio': { 'socket-dir': { type: 'string' } },
  status: { 'socket-dir': { type: 'string' }, json: { type: 'boolean' } },
  version: {},
} as const;

type Command = keyof typeof OPTIONS;

function processSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller.signal;
}

async function status(socketDir: string | undefined, json: boolean, io: HostIo): Promise<number> {
  const dialed = await dialFirst(dialCandidates(socketDir));
  if (!dialed.ok) {
    if (json) io.stdout.write(`${JSON.stringify({ running: false, reason: dialed.failure, socket: dialed.path })}\n`);
    io.stderr.write(`${dialed.message}\n`);
    return exitCodeFor(dialed.failure);
  }
  dialed.socket.destroy();
  const hello = await fetchHello(dialed.path);
  if (json) {
    io.stdout.write(`${JSON.stringify({ running: true, socket: dialed.path, hello })}\n`);
    return 0;
  }
  const ollama = hello.ollama.reachable
    ? `${hello.ollama.url}, version ${hello.ollama.version ?? 'unknown'}`
    : `${hello.ollama.url}, not reachable`;
  io.stdout.write(
    [
      `b4m-host ${hello.version} is running (${hello.mode} mode)`,
      `  socket  ${dialed.path} (role ${hello.role})`,
      `  server  ${hello.serverId}`,
      `  ollama  ${ollama}`,
      '',
    ].join('\n')
  );
  return 0;
}

/** Runs one `b4m-host` command and resolves with its exit code; `serve` resolves once it has stopped. */
export async function runHost(argv: readonly string[], partialIo: Partial<HostIo> = {}): Promise<number> {
  const io: HostIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    programName: 'b4m-host',
    ...partialIo,
  };
  const [command, ...rest] = argv;
  if (!command) {
    io.stderr.write(usage(io.programName));
    return EXIT_USAGE;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    io.stdout.write(usage(io.programName));
    return 0;
  }
  if (command === '--version') {
    io.stdout.write(`${HOST_VERSION}\n`);
    return 0;
  }
  if (!Object.keys(OPTIONS).includes(command)) {
    io.stderr.write(`Unknown command: ${command}\n\n${usage(io.programName)}`);
    return EXIT_USAGE;
  }

  let values: Record<string, unknown>;
  try {
    const options: ParseArgsConfig['options'] = OPTIONS[command as Command];
    ({ values } = parseArgs({ args: [...rest], options, strict: true }));
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage(io.programName)}`);
    return EXIT_USAGE;
  }
  const text = (key: string) => (typeof values[key] === 'string' ? values[key] : undefined);
  const socketDir = text('socket-dir');

  try {
    switch (command as Command) {
      case 'version':
        io.stdout.write(`${HOST_VERSION}\n`);
        return 0;
      case 'status':
        return await status(socketDir, values.json === true, io);
      case 'dial-stdio':
        return await dialStdio({ candidates: dialCandidates(socketDir), ...io });
      case 'serve':
        await serve({
          mode: values.user ? 'user' : 'system',
          socketDir,
          stateDir: text('state-dir'),
          ollamaUrl: text('ollama-url') ?? DEFAULT_OLLAMA_URL,
          signal: io.signal ?? processSignal(),
          log: line => io.stderr.write(`b4m-host: ${line}\n`),
        });
        return 0;
    }
  } catch (error) {
    io.stderr.write(`b4m-host: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
