import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeFailure } from './failure';
import { probeServer } from './probe';
import {
  createSshFetch,
  describeSshFailure,
  parseSshDestination,
  setsControlPath,
  sharedControlPath,
  SSH_OLLAMA_URL,
  sshArgs,
  sshChildEnv,
  SshConnectionError,
  sshDestinationProblem,
  SshRefusedError,
  suggestSshName,
  type SshDeps,
} from './ssh';

describe('SSH destinations', () => {
  it('accepts user@host and Host aliases', () => {
    for (const value of ['user@gpu-box', 'gpu-box', 'gpu.lab.example.com', 'my_alias', 'u.ser@10.0.0.5', ' gpu ']) {
      expect(parseSshDestination(value)).toBe(value.trim());
    }
  });

  it('refuses a destination starting with "-" so it cannot pass as an ssh option', () => {
    expect(parseSshDestination('-oProxyCommand=touch /tmp/x')).toBeNull();
    expect(sshDestinationProblem('-oProxyCommand=touch /tmp/x')).toBe('An SSH destination cannot start with "-".');
    expect(parseSshDestination('user@-oProxyCommand=x')).toBeNull();
  });

  it('suggests the host without its user or domain, keeping an IPv4 address whole', () => {
    expect(suggestSshName('me@gpu.lab.example.com')).toBe('gpu');
    expect(suggestSshName('gpu-box')).toBe('gpu-box');
    expect(suggestSshName('me@10.0.0.5')).toBe('10.0.0.5');
  });

  it('refuses characters outside the host name set', () => {
    for (const value of [
      'user@host name',
      'host;rm',
      'user@host:22',
      'ssh://host',
      'a@b@c',
      '$(id)',
      '',
      'host\n-oX',
    ]) {
      expect(parseSshDestination(value), value).toBeNull();
    }
  });
});

describe('the ssh child environment', () => {
  it('passes only the allowlisted variables', () => {
    const env = sshChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        USER: 'me',
        SSH_AUTH_SOCK: '/run/agent.sock',
        LANG: 'en_US.UTF-8',
        OPENAI_API_KEY: 'sk-secret',
        B4M_API_KEY: 'b4m_live_secret',
        NODE_OPTIONS: '--require /tmp/x.js',
        LD_PRELOAD: '/tmp/x.so',
        ELECTRON_RUN_AS_NODE: '1',
        DISPLAY: ':0',
        SSH_ASKPASS: '/usr/bin/ssh-askpass',
        SSH_ASKPASS_REQUIRE: 'force',
      },
      'linux'
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      USER: 'me',
      SSH_AUTH_SOCK: '/run/agent.sock',
      LANG: 'en_US.UTF-8',
    });
  });

  it('matches names case-insensitively on Windows only', () => {
    expect(sshChildEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', Secret: 'x' }, 'win32')).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
    });
    expect(sshChildEnv({ Path: '/usr/bin', path: '/x' }, 'linux')).toEqual({});
  });
});

describe('ssh arguments', () => {
  it('run ssh non-interactively with a stdio forward and -- before the destination', () => {
    const args = sshArgs('user@gpu');
    for (const option of [
      'BatchMode=yes',
      'ConnectTimeout=15',
      'RemoteCommand=none',
      'StrictHostKeyChecking=yes',
      'ForwardAgent=no',
      'ForwardX11=no',
      'PermitLocalCommand=no',
      'ClearAllForwardings=yes',
    ]) {
      expect(args[args.indexOf(option) - 1], option).toBe('-o');
    }
    expect(args.slice(-4)).toEqual(['-W', '127.0.0.1:11434', '--', 'user@gpu']);
    expect(args.filter(arg => arg.startsWith('Control'))).toEqual(['ControlMaster=no']);
  });

  it('turn connection sharing off outright on Windows', () => {
    expect(sshArgs('gpu', null, 'win32').filter(arg => arg.startsWith('Control'))).toEqual([
      'ControlMaster=no',
      'ControlPath=none',
    ]);
  });

  it('add connection sharing only when given a control path', () => {
    const args = sshArgs('gpu', '~/.ssh/b4m/%C');
    expect(args).toEqual(expect.arrayContaining(['ControlMaster=auto', 'ControlPath=~/.ssh/b4m/%C']));
    expect(args.slice(-2)).toEqual(['--', 'gpu']);
  });
});

describe('connection sharing', () => {
  it('uses ~/.ssh/b4m/%C when the socket path fits', () => {
    expect(sharedControlPath('/home/me', 'linux')).toEqual({ dir: '/home/me/.ssh/b4m', option: '~/.ssh/b4m/%C' });
    expect(sharedControlPath('/Users/me', 'darwin')?.option).toBe('~/.ssh/b4m/%C');
  });

  it('is skipped when the home path is too long for the socket limit', () => {
    // 104 bytes on macOS: the directory, a slash, 40 hash characters and the 17-character temporary suffix.
    const fits = `/Users/${'a'.repeat(104 - 1 - 57 - '/Users/'.length - '/.ssh/b4m'.length - 1)}`;
    expect(sharedControlPath(fits, 'darwin')).not.toBeNull();
    expect(sharedControlPath(`${fits}a`, 'darwin')).toBeNull();
    expect(sharedControlPath(`/home/${'x'.repeat(60)}`, 'linux')).toBeNull();
    // Counted in bytes: 20 two-byte characters are 40 bytes.
    expect(sharedControlPath(`/home/${String.fromCharCode(0xe9).repeat(20)}`, 'linux')).toBeNull();
    expect(sharedControlPath(`/home/${'e'.repeat(20)}`, 'linux')).not.toBeNull();
  });

  it('is skipped on Windows, whose OpenSSH cannot share connections', () => {
    expect(sharedControlPath('C:/Users/me', 'win32')).toBeNull();
  });

  it("reads the user's own ControlPath from ssh -G", () => {
    expect(setsControlPath('user me\ncontrolmaster false\ncontrolpersist no\n')).toBe(false);
    expect(setsControlPath('controlpath none\n')).toBe(false);
    expect(setsControlPath('controlmaster auto\ncontrolpath /home/me/.ssh/cm-%C\n')).toBe(true);
  });
});

describe('ssh failures', () => {
  it('fails closed on an unknown host key with the terminal hint', () => {
    const err = describeSshFailure(
      'No ED25519 host key is known for gpu and you have requested strict checking.\r\nHost key verification failed.\r\n',
      255,
      'me@gpu'
    );
    expect(err).toBeInstanceOf(SshRefusedError);
    expect(err.message).toBe("Connect once from a terminal with `ssh me@gpu` to trust this server's host key.");
  });

  it('says a changed host key changed', () => {
    const err = describeSshFailure(
      '@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.\n',
      255,
      'gpu'
    );
    expect(err).toBeInstanceOf(SshRefusedError);
    expect(err.message).toMatch(/host key of gpu has changed/);
  });

  it('points a refused login at the terminal and ssh-agent', () => {
    const err = describeSshFailure('me@gpu: Permission denied (publickey).\n', 255, 'me@gpu');
    expect(err).toBeInstanceOf(SshRefusedError);
    expect(err.message).toMatch(/Check that `ssh me@gpu` works in a terminal/);
    expect(err.message).toMatch(/ssh-agent/);
  });

  it('names a server that forbids forwarding, and one without Ollama running', () => {
    expect(
      describeSshFailure(
        'channel 0: open failed: administratively prohibited: open failed\nstdio forwarding failed\n',
        255,
        'gpu'
      )
    ).toBeInstanceOf(SshRefusedError);
    const down = describeSshFailure(
      'channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed\n',
      255,
      'gpu'
    );
    expect(down).toBeInstanceOf(SshConnectionError);
    expect(down.message).toBe(
      'SSH to gpu works, but nothing answers at 127.0.0.1:11434 there. Start Ollama on that machine.'
    );
  });

  it('names both causes when a shared connection refuses the forward', () => {
    const err = describeSshFailure('Stdio forwarding request failed: Session open refused by peer\n', 255, 'gpu');
    expect(err).toBeInstanceOf(SshConnectionError);
    expect(err.message).toMatch(/refused the forward to 127\.0\.0\.1:11434.*Ollama is running.*AllowTcpForwarding/);
  });

  it('reads a refused forward as a stopped Ollama even when a key file or banner mentions permission', () => {
    const refused = 'channel 0: open failed: connect failed: Connection refused';
    for (const prefix of [
      'Load key "/home/me/.ssh/id_old": Permission denied',
      'Banner: permission denied for guests, see policy',
    ]) {
      const err = describeSshFailure(`${prefix}\n${refused}\n`, 255, 'gpu');
      expect(err, prefix).toBeInstanceOf(SshConnectionError);
      expect(err.message).toContain('Start Ollama on that machine.');
    }
  });

  it('keeps the last useful line otherwise, without control characters', () => {
    const err = describeSshFailure(
      'Warning: Permanently added x\nssh: connect to host gpu port 22: Connection timed out\x1b[0m\n',
      255,
      'gpu'
    );
    expect(err).toBeInstanceOf(SshConnectionError);
    expect(err.message).toBe('ssh gpu failed: ssh: connect to host gpu port 22: Connection timed out[0m');
    expect(describeFailure(new TypeError('fetch failed', { cause: err }))).toBe(err.message);
  });
});

interface Spawned {
  command: string;
  args: string[];
  env: Record<string, string>;
  detached?: boolean;
}

type FakeChild = ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  child.kill = vi.fn(() => {
    finish(child, null, 'SIGTERM');
    return true;
  }) as never;
  return child;
}

function finish(child: FakeChild, code: number | null, signal: NodeJS.Signals | null = null) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  Object.assign(child, { exitCode: code, signalCode: signal });
  child.stdout.end();
  child.stderr.end();
  setImmediate(() => {
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  });
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function ollama(): Promise<number> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/api/version' ? '{"version":"0.12.0"}' : '{"models":[{"name":"qwen2.5:0.5b"}]}');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const CHAT_LINES = Array.from({ length: 5 }, (_, index) => `{"message":{"content":"t${index}"},"done":false}\n`);

/** An Ollama that streams `CHAT_LINES` chunked, one per `delayMs`, and stops writing once the client is gone. */
async function streamingOllama(delayMs: number): Promise<number> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent < CHAT_LINES.length) res.write(CHAT_LINES[sent++]);
      else {
        clearInterval(timer);
        res.end();
      }
    }, delayMs);
    res.on('close', () => clearInterval(timer));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * A stand-in for the ssh binary: `-G` prints `config`, and `-W` pipes stdio to a local port the way the
 * real forward reaches the far end's Ollama, or fails with `stderr` when it is set.
 */
function fakeSsh(port: number, opts: { config?: string; stderr?: string } = {}) {
  const spawned: Spawned[] = [];
  const children: FakeChild[] = [];
  const spawn: SshDeps['spawn'] = (command, args, options) => {
    spawned.push({ command, args, env: options.env, detached: options.detached });
    const child = fakeChild();
    children.push(child);
    if (args[0] === '-G') {
      setImmediate(() => {
        child.stdout.write(opts.config ?? 'user me\ncontrolmaster false\n');
        finish(child, 0);
      });
      return child;
    }
    if (opts.stderr) {
      setImmediate(() => {
        child.stderr.write(opts.stderr);
        finish(child, 255);
      });
      return child;
    }
    const socket = net.connect(port, '127.0.0.1');
    child.stdin.pipe(socket);
    socket.on('data', chunk => child.stdout.write(chunk));
    socket.on('end', () => finish(child, 0));
    socket.on('error', () => finish(child, 255));
    child.on('close', () => socket.destroy());
    return child;
  };
  return { spawn, spawned, children };
}

const SECRET_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/me',
  SSH_AUTH_SOCK: '/agent',
  OPENAI_API_KEY: 'sk-x',
  DISPLAY: ':0',
};

describe('createSshFetch', () => {
  it('carries an HTTP request through the forward and gives ssh only the allowlisted environment', async () => {
    const ssh = fakeSsh(await ollama());
    const makeDir = vi.fn(async () => undefined);
    const fetch = createSshFetch(
      { destination: 'me@gpu', label: 'gpu' },
      { spawn: ssh.spawn, env: SECRET_ENV, platform: 'linux', home: '/home/me', makeDir }
    );
    const response = await fetch(`${SSH_OLLAMA_URL}/api/version`);
    expect(await response.json()).toEqual({ version: '0.12.0' });
    const forward = ssh.spawned.find(call => call.args.includes('-W'));
    expect(ssh.spawned[0].args).toEqual(['-G', '--', 'me@gpu']);
    expect(forward?.command).toBe('ssh');
    expect(forward?.args).toEqual(expect.arrayContaining(['RemoteCommand=none', 'ControlPath=~/.ssh/b4m/%C']));
    expect(forward?.args.slice(-2)).toEqual(['--', 'me@gpu']);
    for (const call of ssh.spawned)
      expect(call.env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', SSH_AUTH_SOCK: '/agent' });
    expect(makeDir).toHaveBeenCalledWith('/home/me/.ssh/b4m');
    expect(forward?.detached).toBe(true);
  });

  it("reuses the user's master when their ssh config sets a ControlPath, but never becomes one", async () => {
    const ssh = fakeSsh(await ollama(), { config: 'controlmaster auto\ncontrolpath ~/.ssh/cm-%r@%h:%p\n' });
    const fetch = createSshFetch(
      { destination: 'gpu', label: 'gpu' },
      { spawn: ssh.spawn, env: SECRET_ENV, platform: 'linux', home: '/home/me', makeDir: async () => undefined }
    );
    await (await fetch(`${SSH_OLLAMA_URL}/api/tags`)).json();
    const forward = ssh.spawned.find(call => call.args.includes('-W'));
    expect(forward?.args.filter(arg => arg.startsWith('Control'))).toEqual(['ControlMaster=no']);
  });

  it.skipIf(process.platform === 'win32')('makes an existing ~/.ssh/b4m private', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'b4m-ssh-'));
    try {
      await mkdir(path.join(home, '.ssh', 'b4m'), { recursive: true, mode: 0o755 });
      const ssh = fakeSsh(await ollama());
      const fetch = createSshFetch({ destination: 'gpu', label: 'gpu' }, { spawn: ssh.spawn, platform: 'linux', home });
      await (await fetch(`${SSH_OLLAMA_URL}/api/version`)).json();
      expect((await stat(path.join(home, '.ssh', 'b4m'))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('classifies a failure from the end of a long debug log', async () => {
    const debug = 'debug1: reading configuration data /etc/ssh/ssh_config\n'.repeat(400);
    const ssh = fakeSsh(await ollama(), { stderr: `${debug}Host key verification failed.\n` });
    const fetch = createSshFetch({ destination: 'gpu', label: 'gpu' }, { spawn: ssh.spawn, platform: 'win32' });
    await expect(fetch(`${SSH_OLLAMA_URL}/api/version`)).rejects.toThrow(
      "Connect once from a terminal with `ssh gpu` to trust this server's host key."
    );
    expect(ssh.spawned[0].detached).toBe(false);
  });

  it('skips sharing under a long home path and still connects', async () => {
    const ssh = fakeSsh(await ollama());
    const fetch = createSshFetch(
      { destination: 'gpu', label: 'gpu' },
      { spawn: ssh.spawn, env: SECRET_ENV, platform: 'darwin', home: `/Users/${'x'.repeat(80)}` }
    );
    expect(await (await fetch(`${SSH_OLLAMA_URL}/api/version`)).json()).toEqual({ version: '0.12.0' });
    expect(ssh.spawned.map(call => call.args[0])).not.toContain('-G');
    for (const call of ssh.spawned)
      expect(call.args.filter(arg => arg.startsWith('Control'))).toEqual(['ControlMaster=no']);
  });

  it('fails closed on an unknown host key, which a probe reports as refused with the hint', async () => {
    const ssh = fakeSsh(await ollama(), {
      stderr:
        'No ED25519 host key is known for gpu and you have requested strict checking.\nHost key verification failed.\n',
    });
    const fetch = createSshFetch(
      { destination: 'me@gpu', label: 'gpu' },
      { spawn: ssh.spawn, env: SECRET_ENV, platform: 'win32' }
    );
    await expect(fetch(`${SSH_OLLAMA_URL}/api/version`)).rejects.toBeInstanceOf(SshRefusedError);
    const outcome = await probeServer(fetch, SSH_OLLAMA_URL, 'gpu', () => 0, 'ollama');
    expect(outcome).toMatchObject({
      kind: null,
      refused: true,
      error: "Connect once from a terminal with `ssh me@gpu` to trust this server's host key.",
    });
  });

  it('reports a stopped Ollama on the far end as unreachable', async () => {
    const ssh = fakeSsh(await ollama(), { stderr: 'channel 0: open failed: connect failed: Connection refused\n' });
    const fetch = createSshFetch({ destination: 'gpu', label: 'gpu' }, { spawn: ssh.spawn, platform: 'win32' });
    const outcome = await probeServer(fetch, SSH_OLLAMA_URL, 'gpu', () => 0, 'ollama');
    expect(outcome.refused).toBe(false);
    expect(outcome.error).toBe(
      'Could not reach gpu: SSH to gpu works, but nothing answers at 127.0.0.1:11434 there. Start Ollama on that machine.'
    );
  });

  it('never spawns ssh for a destination that is not valid', async () => {
    const ssh = fakeSsh(await ollama());
    const fetch = createSshFetch({ destination: '-oProxyCommand=x', label: 'x' }, { spawn: ssh.spawn });
    await expect(fetch(`${SSH_OLLAMA_URL}/api/version`)).rejects.toThrow('An SSH destination cannot start with "-".');
    expect(ssh.spawned).toEqual([]);
  });

  it('says when ssh is not installed', async () => {
    const fetch = createSshFetch(
      { destination: 'gpu', label: 'gpu' },
      { command: '/nonexistent/b4m-ssh', platform: 'win32', env: SECRET_ENV }
    );
    await expect(fetch(`${SSH_OLLAMA_URL}/api/version`)).rejects.toThrow(
      'Desktop could not find the ssh command. Install the OpenSSH client.'
    );
  });

  describe('streaming a chat response', () => {
    const chat = (fetch: ReturnType<typeof createSshFetch>, signal?: AbortSignal) =>
      fetch(`${SSH_OLLAMA_URL}/api/chat`, { method: 'POST', body: '{}', signal });
    const forwardOf = (ssh: ReturnType<typeof fakeSsh>) =>
      ssh.children[ssh.spawned.findIndex(c => c.args.includes('-W'))];

    it('delivers every streamed line and ends the ssh process once the body is read', async () => {
      const ssh = fakeSsh(await streamingOllama(10));
      const fetch = createSshFetch({ destination: 'gpu', label: 'gpu' }, { spawn: ssh.spawn, platform: 'win32' });
      const response = await chat(fetch);
      expect(await response.text()).toBe(CHAT_LINES.join(''));
      await vi.waitFor(() => expect(forwardOf(ssh).exitCode !== null || forwardOf(ssh).signalCode !== null).toBe(true));
    });

    it('kills the ssh process when the reader cancels mid-stream', async () => {
      const ssh = fakeSsh(await streamingOllama(40));
      const fetch = createSshFetch({ destination: 'gpu', label: 'gpu' }, { spawn: ssh.spawn, platform: 'win32' });
      const response = await chat(fetch);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      await vi.waitFor(() => expect(forwardOf(ssh).kill).toHaveBeenCalled());
    });

    it('kills the ssh process when the request is aborted mid-stream', async () => {
      const ssh = fakeSsh(await streamingOllama(40));
      const fetch = createSshFetch({ destination: 'gpu', label: 'gpu' }, { spawn: ssh.spawn, platform: 'win32' });
      const controller = new AbortController();
      const response = await chat(fetch, controller.signal);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      controller.abort();
      await expect(reader.read()).rejects.toThrow();
      await vi.waitFor(() => expect(forwardOf(ssh).kill).toHaveBeenCalled());
    });
  });

  it('kills the ssh process when the request is aborted', async () => {
    const children: FakeChild[] = [];
    const spawn: SshDeps['spawn'] = () => {
      const child = fakeChild();
      children.push(child);
      return child;
    };
    const fetch = createSshFetch({ destination: 'gpu', label: 'gpu' }, { spawn, platform: 'win32' });
    const controller = new AbortController();
    const pending = fetch(`${SSH_OLLAMA_URL}/api/version`, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(children[0].kill).toHaveBeenCalled();
  });
});
