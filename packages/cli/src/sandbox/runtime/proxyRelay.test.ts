import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PROXY_RELAY_SOURCE } from './proxyRelay.js';

function runRelay(port: number, socketPath: string, command: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', PROXY_RELAY_SOURCE, String(port), socketPath, command]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Shell command that sends "ping" to 127.0.0.1:<port> and prints the reply. */
const pingCommand = (port: number) =>
  `"${process.execPath}" -e 'const s=require("net").connect(${port},"127.0.0.1",()=>s.end("ping"));s.pipe(process.stdout)'`;

describe('proxy relay', () => {
  let dir: string;
  let socketPath: string;
  let upstream: net.Server;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'b4m-relay-'));
    socketPath = path.join(dir, 'proxy.sock');
    upstream = net.createServer(socket => socket.on('data', data => socket.end(`pong:${data}`)));
    await new Promise<void>(resolve => upstream.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards loopback TCP on the proxy port to the Unix socket before running the command', async () => {
    const port = await freePort();
    const result = await runRelay(port, socketPath, pingCommand(port));
    expect(result.stdout).toBe('pong:ping');
    expect(result.code).toBe(0);
  });

  it('exits with the command status', async () => {
    const result = await runRelay(await freePort(), socketPath, 'echo out; exit 7');
    expect(result.stdout).toBe('out\n');
    expect(result.code).toBe(7);
  });

  it('still runs the command, without the relay, when the port is taken', async () => {
    const taken = net.createServer();
    await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', resolve));
    const { port } = taken.address() as net.AddressInfo;
    try {
      const result = await runRelay(port, socketPath, 'echo ran');
      expect(result.stdout).toBe('ran\n');
      expect(result.stderr).toContain('running without network');
      expect(result.code).toBe(0);
    } finally {
      await new Promise(resolve => taken.close(resolve));
    }
  });
});
