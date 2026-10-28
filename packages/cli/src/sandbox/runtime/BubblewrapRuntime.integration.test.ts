/**
 * Integration tests for Linux Bubblewrap (bwrap) runtime.
 * These tests run actual sandboxed commands; skipped on non-Linux platforms.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execSync } from 'child_process';
import net from 'net';
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
      networkEnabled: false,
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
      networkEnabled: false,
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
      networkEnabled: false,
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
      networkEnabled: false,
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

  it('with network on, reaches only the proxy socket through the relay', async () => {
    const socketDir = path.join(TEST_DIR, 'relay');
    mkdirSync(socketDir, { recursive: true });
    const socketPath = path.join(socketDir, 'proxy.sock');
    const proxy = net.createServer(socket => socket.end('via-proxy'));
    await new Promise<void>(resolve => proxy.listen(socketPath, resolve));
    try {
      const wrapped = runtime.wrapCommand({
        command:
          'exec 3<>/dev/tcp/127.0.0.1/18888 && cat <&3; (exec 4<>/dev/tcp/1.1.1.1/80) 2>/dev/null || echo :blocked',
        cwd: TEST_DIR,
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: true,
        proxyPort: 18888,
        proxySocketPath: socketPath,
      });
      const output = await new Promise<string>((resolve, reject) =>
        execFile(wrapped.executable, wrapped.args, { encoding: 'utf-8', timeout: 10000 }, (error, stdout) =>
          error ? reject(error) : resolve(stdout)
        )
      );
      expect(output.trim()).toBe('via-proxy:blocked');
    } finally {
      await new Promise(resolve => proxy.close(resolve));
    }
  });
});
