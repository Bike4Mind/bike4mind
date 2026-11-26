import { closeSync, mkdtempSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_OUTPUT_FILE_NAME, openDaemonOutput } from './daemonOutput';

const directories: string[] = [];
const tempDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'host-out-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const writeRun = (directory: string, text: string) => {
  const descriptor = openDaemonOutput(directory);
  try {
    writeSync(descriptor, text);
  } finally {
    closeSync(descriptor);
  }
};

describe('openDaemonOutput', () => {
  it('starts each run in a fresh owner-only file', () => {
    const directory = tempDirectory();

    writeRun(directory, 'first run\n');

    const path = join(directory, DAEMON_OUTPUT_FILE_NAME);
    expect(readFileSync(path, 'utf8')).toBe('first run\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps only the previous run beside the current one', () => {
    const directory = tempDirectory();

    writeRun(directory, 'first run\n');
    writeRun(directory, 'second run\n');
    writeRun(directory, 'third run\n');

    const path = join(directory, DAEMON_OUTPUT_FILE_NAME);
    expect(readFileSync(path, 'utf8')).toBe('third run\n');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('second run\n');
  });
});
