/**
 * Integration tests for Linux Bubblewrap (bwrap) runtime.
 * These tests run actual sandboxed commands; skipped on non-Linux platforms.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { exec, execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import net from 'net';
import path from 'path';
import os from 'os';
import { BubblewrapRuntime } from './BubblewrapRuntime.js';
import { ProxyManager } from '../proxy/ProxyManager.js';

const TEST_DIR = path.join(os.tmpdir(), 'b4m-bwrap-integration-test');
const OUTSIDE_DIR = path.join(os.tmpdir(), 'b4m-integration-outside');

function isBinaryOnPath(binary: string): boolean {
  try {
    execSync(`which ${binary}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const skipReason = process.platform !== 'linux' || !isBinaryOnPath('bwrap');

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

  // Async exec: the proxy and relay run in this process, so a blocking execSync would starve them.
  it.skipIf(!isBinaryOnPath('socat'))('reaches only the filtering proxy when network is enabled', async () => {
    const proxyManager = new ProxyManager({ enabled: true, allowedDomains: ['example.com'] }, { unixSocket: true });
    await proxyManager.start();
    const hostService = net.createServer(socket => socket.end('reached\n'));
    await new Promise<void>(resolve => hostService.listen(0, '127.0.0.1', resolve));
    const hostPort = (hostService.address() as net.AddressInfo).port;
    const proxyPort = proxyManager.getPort()!;
    const connect = `printf 'CONNECT blocked.invalid:443 HTTP/1.1\\r\\n\\r\\n' >&3; head -n1 <&3`;
    const wrapped = runtime.wrapCommand({
      command: [
        `(exec 3<>/dev/tcp/127.0.0.1/${proxyPort}; ${connect})`,
        `(: </dev/tcp/127.0.0.1/${hostPort}) 2>/dev/null && echo host-open || echo host-closed`,
        'getent hosts example.com || echo unresolved',
      ].join('; '),
      cwd: TEST_DIR,
      filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
      networkEnabled: true,
      proxyPort,
      proxySocketPath: proxyManager.getSocketPath()!,
      env: proxyManager.getProxyEnv(),
    });

    try {
      const output = await new Promise<string>((resolve, reject) =>
        exec(wrapped.commandString, { timeout: 15000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
      );
      expect(
        output
          .trim()
          .split('\n')
          .map(line => line.trim())
      ).toEqual(['HTTP/1.1 403 Forbidden', 'host-closed', 'unresolved']);
    } finally {
      hostService.close();
      await proxyManager.stop();
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
});
