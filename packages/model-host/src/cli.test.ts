import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from './__test__/helpers';
import { runHost } from './cli';
import { HOST_VERSION } from './version';

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

function io(signal?: AbortSignal) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = { out: '', err: '' };
  stdout.on('data', chunk => (output.out += chunk));
  stderr.on('data', chunk => (output.err += chunk));
  return { output, io: { stdin: new PassThrough(), stdout, stderr, programName: 'b4m host', signal } };
}

describe('runHost', () => {
  it('prints the version and help, and refuses unknown commands and options with exit 2', async () => {
    const version = io();
    expect(await runHost(['version'], version.io)).toBe(0);
    expect(version.output.out).toBe(`${HOST_VERSION}\n`);
    const help = io();
    expect(await runHost(['--help'], help.io)).toBe(0);
    expect(help.output.out).toContain('Usage: b4m host <command>');
    expect(await runHost(['install'], io().io)).toBe(2);
    const bad = io();
    expect(await runHost(['serve', '--bogus'], bad.io)).toBe(2);
    expect(bad.output.err).toContain("Unknown option '--bogus'");
  });

  it('reports status: exit 3 when stopped, then the role and mode of a running user host', async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const socketDir = join(dir, 'run');
    const stopped = io();
    expect(await runHost(['status', '--socket-dir', socketDir, '--json'], stopped.io)).toBe(3);
    expect(JSON.parse(stopped.output.out)).toEqual({ running: false, reason: 'not-running', socket: null });

    const controller = new AbortController();
    const server = io(controller.signal);
    const serving = runHost(
      [
        'serve',
        '--user',
        '--socket-dir',
        socketDir,
        '--state-dir',
        join(dir, 'state'),
        '--ollama-url',
        'http://127.0.0.1:9',
      ],
      server.io
    );
    cleanups.push(async () => {
      controller.abort();
      await serving;
    });
    for (let i = 0; i < 100 && !server.output.err.includes('listening on'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const running = io();
    expect(await runHost(['status', '--socket-dir', socketDir], running.io)).toBe(0);
    expect(running.output.out).toContain(`b4m-host ${HOST_VERSION} is running (user mode)`);
    expect(running.output.out).toContain(`${join(socketDir, 'admin.sock')} (role admin)`);
    expect(running.output.out).toContain('http://127.0.0.1:9, not reachable');
    controller.abort();
    expect(await serving).toBe(0);
  });
});
