import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HostConnectError,
  HostRequestError,
  type HostCloseReason,
  type HostConnectFailureKind,
  type HostNotification,
} from '@shared/hostProtocol';
import { HOST_EXIT_CODES } from '../../../host/headless/exitCodes';
import { ACCOUNT } from '../__fixtures__/fakeHost';
import { ConnectionManager } from '../ConnectionManager';
import { createProcessTransport, failureForExit, STDERR_TAIL_LENGTH, type ProcessSpec } from './processTransport';
import { REMOTE_CONNECT_COMMAND } from './sshCommand';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

/** A child Node process running `script`, with `lines` (an async iterator of stdin lines) in scope. */
const nodeSpec = (script: string): ProcessSpec => ({
  command: process.execPath,
  args: ['-e', `const lines = require('node:readline').createInterface({ input: process.stdin }); ${script}`],
  env: { PATH: process.env.PATH ?? '' },
  label: 'test-host',
});

/** Answers each request with its own method and params; the second request is answered before the first. */
const REORDERING_HOST = `
  const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
  send({ jsonrpc: '2.0', method: 'host/stateChanged', params: { account: null } });
  let held = null;
  lines.on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'fail') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'no such method' } });
      return;
    }
    const answer = { jsonrpc: '2.0', id: request.id, result: { method: request.method, params: request.params } };
    if (held === null) { held = answer; return; }
    send(answer);
    send(held);
    held = null;
  });
`;

const exitWith = (code: number, stderr = '') =>
  nodeSpec(`process.stderr.write(${JSON.stringify(stderr)}); lines.once('line', () => process.exit(${code}));`);

const closeReason = (transport: { onClose(listener: (reason: HostCloseReason) => void): () => void }) =>
  new Promise<HostCloseReason>(resolve => transport.onClose(resolve));

const isAlive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('failureForExit', () => {
  it.each<[number | null, HostConnectFailureKind]>([
    [HOST_EXIT_CODES.unsupportedPlatform, 'unsupportedPlatform'],
    [HOST_EXIT_CODES.nodeTooOld, 'nodeTooOld'],
    [HOST_EXIT_CODES.daemonVersionMismatch, 'daemonVersionMismatch'],
    [HOST_EXIT_CODES.daemonStartTimeout, 'daemonStartTimeout'],
    [HOST_EXIT_CODES.daemonAlreadyRunning, 'lost'],
    [HOST_EXIT_CODES.daemonConnectionLost, 'lost'],
    [126, 'notInstalled'],
    [127, 'notInstalled'],
    [255, 'sshFailed'],
    [0, 'lost'],
    [1, 'lost'],
    [null, 'lost'],
  ])('exit %s is %s', (code, kind) => {
    expect(failureForExit(code, code === null ? 'SIGKILL' : null, 'tail', 'devbox')).toMatchObject({
      kind,
      stderrTail: 'tail',
    });
  });

  it("shows ssh's own last line for an SSH failure", () => {
    const stderr = 'debug noise\nuser@devbox: Permission denied (publickey).\n\n';
    expect(failureForExit(255, null, stderr, 'devbox').detail).toBe('user@devbox: Permission denied (publickey).');
    expect(failureForExit(255, null, '', 'devbox').detail).toBe('Could not connect to devbox over SSH (exit code 255)');
    expect(failureForExit(127, null, 'sh: not found', 'devbox').detail).toBe(
      'The Bike4Mind host program is not installed on devbox (exit code 127)'
    );
  });
});

describePosix('createProcessTransport', () => {
  it('pairs responses with their requests in any order and delivers notifications', async () => {
    const transport = await createProcessTransport(nodeSpec(REORDERING_HOST));
    const notifications: HostNotification[] = [];
    transport.onNotification(notification => notifications.push(notification));

    const [first, second] = await Promise.all([
      transport.request('host/info'),
      transport.request('session/get', { sessionId: 's1' }),
    ]);
    expect(first).toEqual({ method: 'host/info' });
    expect(second).toEqual({ method: 'session/get', params: { sessionId: 's1' } });
    await expect(transport.request('fail')).rejects.toBeInstanceOf(HostRequestError);
    expect(notifications.map(notification => notification.method)).toEqual(['host/stateChanged']);
    transport.close();
  });

  it("rejects pending requests with the exit's failure and tells close listeners", async () => {
    const transport = await createProcessTransport(
      exitWith(255, 'ssh: connect to host devbox port 22: Connection refused\n')
    );
    const closed = closeReason(transport);

    const error: unknown = await transport.request('host/initialize').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HostConnectError);
    const expected = {
      kind: 'sshFailed',
      detail: 'ssh: connect to host devbox port 22: Connection refused',
      stderrTail: 'ssh: connect to host devbox port 22: Connection refused\n',
    };
    expect((error as HostConnectError).failure).toEqual(expected);
    expect(await closed).toEqual({ initiator: 'host', failure: expected });
    await expect(transport.request('host/info')).rejects.toBeInstanceOf(HostConnectError);
  });

  it('keeps only the last 8 KiB of stderr', async () => {
    const transport = await createProcessTransport(
      nodeSpec(`process.stderr.write('x'.repeat(20000) + 'END', () => process.exit(1));`)
    );
    const reason = await closeReason(transport);
    const tail = reason.initiator === 'host' ? reason.failure.stderrTail : '';
    expect(tail).toHaveLength(STDERR_TAIL_LENGTH);
    expect(tail.endsWith('END')).toBe(true);
  });

  it('kills the child on close and rejects what was pending', async () => {
    const transport = await createProcessTransport(nodeSpec(`lines.on('line', () => undefined);`));
    const pending = transport.request('host/info');
    const closed = closeReason(transport);
    expect(isAlive(transport.pid)).toBe(true);

    transport.close();

    await expect(pending).rejects.toMatchObject({ failure: { kind: 'lost' } });
    expect(await closed).toEqual({ initiator: 'client' });
    await until(() => !isAlive(transport.pid));
  });

  it('rejects with a typed failure when the program cannot be started', async () => {
    const error: unknown = await createProcessTransport({
      command: '/nonexistent/ssh',
      args: [],
      label: 'devbox',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostConnectError);
    expect((error as HostConnectError).failure.kind).toBe('sshFailed');
  });

  describe('a machine without the host program', () => {
    let home = '';
    beforeAll(async () => {
      home = await mkdtemp(join(tmpdir(), 'b4m-no-host-'));
    });
    afterAll(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it('runs the remote command, which the shell cannot find, and shows as needsInstall', async () => {
      // The same command ssh runs remotely, in a HOME with nothing installed: sh exits 127.
      const spec: ProcessSpec = {
        command: '/bin/sh',
        args: ['-c', REMOTE_CONNECT_COMMAND],
        env: { PATH: process.env.PATH ?? '', HOME: home },
        label: 'devbox',
      };
      const manager = new ConnectionManager({
        client: { clientId: 'c', clientName: 'Desktop', clientVersion: '1' },
        account: { current: () => ACCOUNT, onChanged: () => () => undefined },
      });
      const states: string[] = [];
      manager.onStateChanged(hosts => states.push(hosts[0]?.state.status ?? 'none'));

      manager.register('devbox', { connect: () => createProcessTransport(spec) }, { label: 'devbox', kind: 'remote' });
      await until(() => states.includes('needsInstall'));

      expect(manager.list()[0].state).toEqual({ status: 'needsInstall' });
      manager.dispose();
    });
  });
});
