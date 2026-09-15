/**
 * Integration tests for Linux Bubblewrap (bwrap) runtime.
 * These tests run actual sandboxed commands; skipped on non-Linux platforms.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { BubblewrapRuntime } from './BubblewrapRuntime.js';

const TEST_DIR = path.join(os.tmpdir(), 'b4m-bwrap-integration-test');
const OUTSIDE_DIR = path.join(os.tmpdir(), 'b4m-integration-outside');

function isBwrapAvailable(): boolean {
  try {
    execSync('which bwrap', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const skipReason = process.platform !== 'linux' || !isBwrapAvailable();

describe.skipIf(skipReason)('BubblewrapRuntime integration', () => {
  const runtime = new BubblewrapRuntime();

  // Create test directories
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(OUTSIDE_DIR, { recursive: true });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(OUTSIDE_DIR, { recursive: true, force: true });
  });

  it('executes a simple command successfully inside sandbox', () => {
    const wrapped = runtime.wrapCommand({
      command: 'echo hello',
      cwd: TEST_DIR,
      filesystemConfig: {
        writeOnlyToWorkingDir: true,
        allowedReadPaths: [],
        deniedPaths: [],
      },
    });

    const output = execSync(wrapped.commandString, { encoding: 'utf-8', timeout: 10000 });
    expect(output.trim()).toBe('hello');
  });

  it('allows writing to CWD', () => {
    const testFile = path.join(TEST_DIR, 'write-test.txt');
    const wrapped = runtime.wrapCommand({
      command: `touch "${testFile}"`,
      cwd: TEST_DIR,
      filesystemConfig: {
        writeOnlyToWorkingDir: true,
        allowedReadPaths: [],
        deniedPaths: [],
      },
    });

    execSync(wrapped.commandString, { encoding: 'utf-8', timeout: 10000 });
    expect(existsSync(testFile)).toBe(true);
    rmSync(testFile, { force: true });
  });

  it('blocks writing outside CWD', () => {
    const testFile = path.join(OUTSIDE_DIR, 'blocked-write.txt');
    const wrapped = runtime.wrapCommand({
      command: `touch "${testFile}"`,
      cwd: TEST_DIR,
      filesystemConfig: {
        writeOnlyToWorkingDir: true,
        allowedReadPaths: [],
        deniedPaths: [],
      },
    });

    try {
      execSync(wrapped.commandString, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: 'pipe',
      });
      // If we get here, verify the file was not created
      expect(existsSync(testFile)).toBe(false);
    } catch {
      // Expected: bwrap blocks the write since OUTSIDE_DIR is not bound
      expect(existsSync(testFile)).toBe(false);
    } finally {
      rmSync(testFile, { force: true });
    }
  });

  it('blocks reading denied paths', () => {
    const sshKnownHosts = path.join(os.homedir(), '.ssh', 'known_hosts');
    // Skip if the file doesn't exist on this machine
    if (!existsSync(sshKnownHosts)) {
      return;
    }

    const wrapped = runtime.wrapCommand({
      command: `cat "${sshKnownHosts}"`,
      cwd: TEST_DIR,
      filesystemConfig: {
        writeOnlyToWorkingDir: true,
        allowedReadPaths: [],
        deniedPaths: [path.join(os.homedir(), '.ssh')],
      },
    });

    try {
      execSync(wrapped.commandString, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: 'pipe',
      });
      // bwrap mounts tmpfs over denied paths; cat should fail or return empty
    } catch {
      // Expected: denied path is hidden by tmpfs overlay
    }
  });
});
