import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main, parseCommand } from './cli';
import { HOST_EXIT_CODES } from './exitCodes';
import { HOST_BUILD_VERSION } from './hostBuild';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const realVersions = Object.getOwnPropertyDescriptor(process, 'versions');

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  if (realVersions) Object.defineProperty(process, 'versions', realVersions);
});

function io() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const read = (stream: PassThrough) => () => String(stream.read() ?? '');
  return { io: { stdout, stderr }, stdout: read(stdout), stderr: read(stderr) };
}

describe('b4m-host main', () => {
  it('prints its build version', async () => {
    const run = io();
    expect(await main(['version'], run.io)).toBe(HOST_EXIT_CODES.ok);
    expect(run.stdout()).toBe(`${HOST_BUILD_VERSION}\n`);
  });

  it('refuses Windows with one line and its own exit code', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const run = io();
    expect(await main(['version'], run.io)).toBe(HOST_EXIT_CODES.unsupportedPlatform);
    expect(run.stderr()).toMatch(/^b4m-host: [^\n]+\n$/);
  });

  it('refuses a Node older than the floor with one line and its own exit code', async () => {
    Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '22.12.0' }, configurable: true });
    const run = io();
    expect(await main(['version'], run.io)).toBe(HOST_EXIT_CODES.nodeTooOld);
    expect(run.stderr()).toBe('b4m-host: needs Node 24 or newer; this is 22.12.0\n');
  });

  it.each([[[]], [['bogus']], [['status', '--nope']]])('answers %j with usage and the usage code', async argv => {
    const run = io();
    expect(await main(argv, run.io)).toBe(HOST_EXIT_CODES.usage);
    expect(run.stderr()).toContain('Usage: b4m-host');
  });
});

describe('parseCommand', () => {
  it.each([
    [['daemon'], 'daemon'],
    [['--data-dir', '/x', 'daemon'], 'daemon'],
    [['--verbose', 'status', '--json'], 'status'],
  ])('finds the command in %j', (argv, command) => {
    expect(parseCommand(argv)).toBe(command);
  });

  it.each([[[]], [['bogus']], [['--nope', 'daemon']]])('finds no command in %j', argv => {
    expect(parseCommand(argv)).toBeNull();
  });
});
