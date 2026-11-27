import { spawn } from 'node:child_process';
import { closeSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDaemonOutput } from './daemonOutput';
import { HOST_EXIT_CODES, type HostExitCode } from './exitCodes';
import { HOST_BUILD_VERSION, MINIMUM_NODE_MAJOR } from './hostBuild';

// Only node builtins and constants are imported statically: the platform and Node checks below
// must run before any module that needs a newer Node (node:sqlite among them) is loaded.

const USAGE = `Usage: b4m-host <command> [options]

Commands:
  connect   Bridge stdin and stdout to the host daemon, starting it if needed
  daemon    Run the host daemon in the foreground
  status    Show whether the daemon is running
  stop      Stop the running daemon
  version   Print this build's version

Options:
  --json             status: print JSON
  --verbose          Log debug lines
  --data-dir <path>  Use another data directory (for tests; default ~/.b4m/host)
`;

const COMMANDS = ['connect', 'daemon', 'status', 'stop', 'version'] as const;
type Command = (typeof COMMANDS)[number];
const isCommand = (value: string | undefined): value is Command => COMMANDS.some(command => command === value);

export type CliIo = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };

export function defaultDataDirectory(): string {
  return join(homedir(), '.b4m', 'host');
}

/** The script this process runs, so a daemon can be started from the same build. */
function entryScript(): string {
  const script = process.argv[1];
  if (!script) throw new Error('Cannot tell which script to start the daemon from');
  return resolve(script);
}

function spawnDetachedDaemon(dataDirectory: string, verbose: boolean): void {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const output = openDaemonOutput(dataDirectory);
  try {
    const args = [entryScript(), 'daemon', '--data-dir', dataDirectory, ...(verbose ? ['--verbose'] : [])];
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', output, output], cwd: homedir() });
    child.unref();
  } finally {
    closeSync(output);
  }
}

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      'data-dir': { type: 'string' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
}

/** The command `argv` names wherever the options sit, or null when it names none this CLI runs. */
export function parseCommand(argv: readonly string[]): Command | null {
  try {
    const [command] = parseCli(argv).positionals;
    return isCommand(command) ? command : null;
  } catch {
    return null;
  }
}

export async function main(argv: readonly string[], io: CliIo = process): Promise<HostExitCode> {
  const fail = (code: HostExitCode, message: string): HostExitCode => {
    io.stderr.write(`b4m-host: ${message}\n`);
    return code;
  };
  if (process.platform === 'win32') {
    return fail(HOST_EXIT_CODES.unsupportedPlatform, 'runs on macOS and Linux only');
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MINIMUM_NODE_MAJOR) {
    return fail(
      HOST_EXIT_CODES.nodeTooOld,
      `needs Node ${MINIMUM_NODE_MAJOR} or newer; this is ${process.versions.node}`
    );
  }

  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    return fail(HOST_EXIT_CODES.usage, `${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  const [command, ...extra] = parsed.positionals;
  if (parsed.values.help) {
    io.stdout.write(USAGE);
    return HOST_EXIT_CODES.ok;
  }
  if (!isCommand(command) || extra.length > 0) {
    return fail(
      HOST_EXIT_CODES.usage,
      `${command ? `unknown command "${[command, ...extra].join(' ')}"` : 'no command'}\n\n${USAGE}`
    );
  }

  const dataDirectory = resolve(parsed.values['data-dir'] ?? defaultDataDirectory());
  const { verbose, json } = parsed.values;

  switch (command) {
    case 'version':
      io.stdout.write(`${HOST_BUILD_VERSION}\n`);
      return HOST_EXIT_CODES.ok;
    case 'status': {
      const { formatHostStatus, readHostStatus } = await import('./commands');
      const status = await readHostStatus(dataDirectory);
      io.stdout.write(`${json ? JSON.stringify(status) : formatHostStatus(status)}\n`);
      return HOST_EXIT_CODES.ok;
    }
    case 'stop': {
      const [{ stopDaemon }, { createStderrLogger }] = await Promise.all([import('./commands'), import('./logging')]);
      return stopDaemon(dataDirectory, createStderrLogger(verbose));
    }
    case 'connect': {
      const [{ runConnect }, { createStderrLogger }] = await Promise.all([import('./connect'), import('./logging')]);
      return runConnect({
        dataDirectory,
        version: HOST_BUILD_VERSION,
        stdin: process.stdin,
        stdout: process.stdout,
        logger: createStderrLogger(verbose),
        spawnDaemon: () => spawnDetachedDaemon(dataDirectory, verbose),
      });
    }
    case 'daemon': {
      const { runDaemonProcess } = await import('./daemonProcess');
      return runDaemonProcess({ dataDirectory, homeDirectory: homedir(), version: HOST_BUILD_VERSION, verbose });
    }
  }
}
