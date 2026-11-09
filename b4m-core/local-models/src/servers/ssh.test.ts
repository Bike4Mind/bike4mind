import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackedChildCount } from '../processTree';
import { describeFailure } from './failure';
import { probeServer } from './probe';
import { redactServerResponse } from './serverFetch';
import {
  CONFIG_TIMEOUT_MS,
  createSshFetch,
  describeSshFailure,
  parseSshDestination,
  parseSshPort,
  setsControlPath,
  sharedControlPath,
  SSH_OLLAMA_URL,
  sshArgs,
  sshChildEnv,
  SshConnectionError,
  sshDestinationProblem,
  SshForwardRefusedError,
  SshRefusedError,
  sshServerUrl,
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

describe('far-end ports', () => {
  it('accepts 1 to 65535 as a number or digits', () => {
    expect(parseSshPort(8080)).toBe(8080);
    expect(parseSshPort(' 1234 ')).toBe(1234);
    expect(parseSshPort('65535')).toBe(65_535);
    expect(sshServerUrl(8000)).toBe('http://127.0.0.1:8000');
  });

  it('refuses anything else', () => {
    for (const bad of [0, '0', 65_536, '99999', -1, 1.5, '', ' ', '80a', '8080;id', '1e3', null, undefined, {}]) {
      expect(parseSshPort(bad), String(bad)).toBeNull();
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

  it('forward to the far-end port asked for, and to Ollama by default', () => {
    expect(sshArgs('gpu', null, 'linux', 8080).slice(-4)).toEqual(['-W', '127.0.0.1:8080', '--', 'gpu']);
    expect(sshArgs('gpu', null, 'linux').slice(-4)).toEqual(['-W', '127.0.0.1:11434', '--', 'gpu']);
  });

  it('refuse a port that is not one, so nothing can reach another host or pass as an option', () => {
    for (const bad of [0, 65_536, -22, 22.5, Number.NaN, '22 -oProxyCommand=x', '10.0.0.5:22', 'x']) {
      expect(() => sshArgs('gpu', null, 'linux', bad as number), String(bad)).toThrow(SshRefusedError);
    }
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

  it('names a Windows terminal and ssh-agent for an unknown host key on Windows', () => {
    const err = describeSshFailure('Host key verification failed.\n', 255, 'me@gpu', 'Desktop', 'win32');
    expect(err).toBeInstanceOf(SshRefusedError);
    expect(err.message).toBe(
      "Connect once from a Windows terminal (PowerShell or Command Prompt, not WSL) with `ssh me@gpu` to trust this server's host key. Desktop cannot ask for a passphrase, so a key that has one must be loaded into ssh-agent."
    );
    for (const platform of ['darwin', 'linux'] as const) {
      expect(describeSshFailure('Host key verification failed.\n', 255, 'me@gpu', 'Desktop', platform).message).toBe(
        "Connect once from a terminal with `ssh me@gpu` to trust this server's host key."
      );
    }
  });

  it('leaves the passphrase advice off the changed host key message', () => {
    const err = describeSshFailure('REMOTE HOST IDENTIFICATION HAS CHANGED!\n', 255, 'gpu', 'Desktop', 'win32');
    expect(err.message).toContain('Windows terminal');
    expect(err.message).not.toContain('passphrase');
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

  it('points a refused login on Windows at a Windows terminal, whose keys WSL does not share', () => {
    const err = describeSshFailure('me@gpu: Permission denied (publickey).\n', 255, 'me@gpu', 'Desktop', 'win32');
    expect(err.message).toMatch(
      /Check that `ssh me@gpu` works in a Windows terminal \(PowerShell or Command Prompt, not WSL\)\./
    );
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
      'SSH to gpu works, but Ollama is not running on it: nothing answers at 127.0.0.1:11434 there. Start Ollama on that machine.'
    );
  });

  it('names both causes when a shared connection refuses the forward', () => {
    const err = describeSshFailure('Stdio forwarding request failed: Session open refused by peer\n', 255, 'gpu');
    expect(err).toBeInstanceOf(SshConnectionError);
    expect(err).toMatchObject({ ambiguous: true });
    expect(err.message).toMatch(/refused the forward to 127\.0\.0\.1:11434.*Ollama is running.*AllowTcpForwarding/);
  });

  it('names the port and no particular server for a port other than Ollama', () => {
    const down = describeSshFailure(
      'channel 0: open failed: connect failed: Connection refused\n',
      255,
      'gpu',
      'Desktop',
      'linux',
      8080
    );
    expect(down).toBeInstanceOf(SshForwardRefusedError);
    expect(down).toMatchObject({ ambiguous: false });
    expect(down.message).toBe(
      'SSH to gpu works, but nothing answers at 127.0.0.1:8080 there. Start the model server on that machine, or check its port.'
    );
    const shared = describeSshFailure('Session open refused by peer\n', 255, 'gpu', 'Desktop', 'linux', 8000);
    expect(shared.message).toMatch(/127\.0\.0\.1:8000.*the model server is running.*AllowTcpForwarding/);
    const prohibited = describeSshFailure(
      'open failed: administratively prohibited\n',
      255,
      'gpu',
      'The CLI',
      'linux',
      1234
    );
    expect(prohibited.message).toMatch(/which The CLI needs to reach a model server there/);
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
function fakeSsh(
  port: number,
  opts: { config?: string; stderr?: string; configNeverCloses?: boolean; configDelayMs?: number } = {}
) {
  const spawned: Spawned[] = [];
  const children: FakeChild[] = [];
  const spawn: SshDeps['spawn'] = (command, args, options) => {
    spawned.push({ command, args, env: options.env, detached: options.detached });
    const child = fakeChild();
    children.push(child);
    if (args[0] === '-G' && opts.configNeverCloses) {
      // As when a `Match exec` grandchild keeps the pipes open: killed, but never closes.
      child.kill = vi.fn(() => true) as never;
      return child;
    }
    if (args[0] === '-G') {
      const answer = () => {
        child.stdout.write(opts.config ?? 'user me\ncontrolmaster false\n');
        finish(child, 0);
      };
      if (opts.configDelayMs) setTimeout(answer, opts.configDelayMs);
      else setImmediate(answer);
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
    // Not os.tmpdir(): macOS's long TMPDIR pushes the socket path past the limit, so sharing would be skipped.
    const home = await mkdtemp('/tmp/b4m-ssh-');
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
      "Connect once from a Windows terminal (PowerShell or Command Prompt, not WSL) with `ssh gpu` to trust this server's host key."
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
      error: expect.stringContaining('Connect once from a Windows terminal (PowerShell or Command Prompt, not WSL)'),
    });
  });

  it('reports a stopped Ollama on the far end as unreachable', async () => {
    const ssh = fakeSsh(await ollama(), { stderr: 'channel 0: open failed: connect failed: Connection refused\n' });
    const fetch = createSshFetch({ destination: 'gpu', label: 'gpu' }, { spawn: ssh.spawn, platform: 'win32' });
    const outcome = await probeServer(fetch, SSH_OLLAMA_URL, 'gpu', () => 0, 'ollama');
    expect(outcome.refused).toBe(false);
    expect(outcome.error).toBe(
      'Could not reach gpu: SSH to gpu works, but Ollama is not running on it: nothing answers at 127.0.0.1:11434 there. Start Ollama on that machine.'
    );
  });

  it('never spawns ssh for a destination that is not valid', async () => {
    const ssh = fakeSsh(await ollama());
    const fetch = createSshFetch({ destination: '-oProxyCommand=x', label: 'x' }, { spawn: ssh.spawn });
    await expect(fetch(`${SSH_OLLAMA_URL}/api/version`)).rejects.toThrow('An SSH destination cannot start with "-".');
    expect(ssh.spawned).toEqual([]);
  });

  it('never spawns ssh for a request whose signal has already aborted', async () => {
    const ssh = fakeSsh(await ollama());
    const fetch = createSshFetch({ destination: 'gpu', label: 'gpu' }, { spawn: ssh.spawn, platform: 'win32' });
    const reason = new DOMException('Cancelled', 'AbortError');
    await expect(fetch(`${SSH_OLLAMA_URL}/api/version`, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(ssh.spawned).toEqual([]);
  });

  it('does not read the ssh config for a first request whose signal has already aborted', async () => {
    const ssh = fakeSsh(await ollama());
    const fetch = createSshFetch(
      { destination: 'me@gpu', label: 'gpu' },
      { spawn: ssh.spawn, platform: 'linux', home: '/home/me', makeDir: async () => undefined }
    );
    const reason = new DOMException('Cancelled', 'AbortError');
    await expect(fetch(`${SSH_OLLAMA_URL}/api/version`, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(ssh.spawned).toEqual([]);
  });

  describe('when ssh -G never closes', () => {
    const linux = (ssh: ReturnType<typeof fakeSsh>) =>
      createSshFetch(
        { destination: 'me@gpu', label: 'gpu' },
        { spawn: ssh.spawn, platform: 'linux', home: '/home/me', makeDir: async () => undefined }
      );

    afterEach(() => {
      vi.useRealTimers();
    });

    it('ends a request at its own signal and starts no forward', async () => {
      const ssh = fakeSsh(await ollama(), { configNeverCloses: true });
      const started = performance.now();
      await expect(linux(ssh)(`${SSH_OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(ssh.spawned.map(call => call.args[0])).toEqual(['-G']);
    });

    it('goes ahead without the config once its limit passes', async () => {
      const ssh = fakeSsh(await ollama(), { configNeverCloses: true });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const response = linux(ssh)(`${SSH_OLLAMA_URL}/api/version`);
      await vi.advanceTimersByTimeAsync(CONFIG_TIMEOUT_MS - 1);
      expect(ssh.spawned.map(call => call.args[0])).toEqual(['-G']);
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      expect(await (await response).json()).toEqual({ version: '0.12.0' });
      expect(ssh.children[0].kill).toHaveBeenCalled();
      expect(ssh.spawned.find(call => call.args.includes('-W'))?.args).not.toContain('ControlPath=~/.ssh/b4m/%C');
    });
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

  describe('an OpenAI-compatible server on another far-end port', () => {
    const TOKEN = 'sk-ssh-secret-zz';
    const SSE = [
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    /** A llama-server started with --api-key that streams SSE, echoing a bad key back in its 401 like some proxies do. */
    async function keyedServer(): Promise<{ port: number; seen: (string | undefined)[] }> {
      const seen: (string | undefined)[] = [];
      const server = http.createServer((req, res) => {
        seen.push(req.headers.authorization);
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `bad key ${req.headers.authorization ?? 'none'}` }));
          return;
        }
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"data":[{"id":"qwen","owned_by":"llamacpp"}]}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let sent = 0;
        const timer = setInterval(() => {
          if (sent < SSE.length) res.write(SSE[sent++]);
          else {
            clearInterval(timer);
            res.end();
          }
        }, 5);
        res.on('close', () => clearInterval(timer));
      });
      servers.push(server);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      return { port: (server.address() as AddressInfo).port, seen };
    }

    it('forwards to that port, adds the token and streams the chat', async () => {
      const keyed = await keyedServer();
      const ssh = fakeSsh(keyed.port);
      const fetch = createSshFetch(
        {
          destination: 'gpu',
          label: 'gpu',
          port: 8080,
          credentialHeaders: () => ({ authorization: `Bearer ${TOKEN}` }),
        },
        { spawn: ssh.spawn, platform: 'win32' }
      );
      const models = await fetch(`${sshServerUrl(8080)}/v1/models`);
      expect(await models.json()).toEqual({ data: [{ id: 'qwen', owned_by: 'llamacpp' }] });
      const chat = await fetch(`${sshServerUrl(8080)}/v1/chat/completions`, {
        method: 'POST',
        body: '{"stream":true}',
      });
      expect(await chat.text()).toBe(SSE.join(''));
      expect(keyed.seen).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
      for (const call of ssh.spawned) {
        expect(call.args.slice(-4)).toEqual(['-W', '127.0.0.1:8080', '--', 'gpu']);
        expect(call.args.join(' ')).not.toContain(TOKEN);
        expect(JSON.stringify(call.env)).not.toContain(TOKEN);
      }
    });

    it('sends only to that port, and scrubs the token from a refusal', async () => {
      const keyed = await keyedServer();
      const ssh = fakeSsh(keyed.port);
      const wrong = 'sk-wrong-key-zz';
      const fetch = createSshFetch(
        {
          destination: 'gpu',
          label: 'gpu',
          port: 8080,
          credentialHeaders: () => ({ authorization: `Bearer ${wrong}` }),
        },
        { spawn: ssh.spawn, platform: 'win32' }
      );
      const refused = await fetch(`${sshServerUrl(8080)}/v1/models`);
      expect(refused.status).toBe(401);
      expect(redactServerResponse(await refused.text(), refused)).not.toContain(wrong);
      await expect(fetch(`${SSH_OLLAMA_URL}/api/version`)).rejects.toThrow(
        "only sends gpu's requests to its own address"
      );
    });

    it('never spawns ssh for a port that is not one', async () => {
      const ssh = fakeSsh(await ollama());
      const fetch = createSshFetch({ destination: 'gpu', label: 'gpu', port: 0 }, { spawn: ssh.spawn });
      await expect(fetch(`${sshServerUrl(0)}/v1/models`)).rejects.toThrow('a number from 1 to 65535');
      expect(ssh.spawned).toEqual([]);
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

describe('the ssh config read', () => {
  it('tracks the pending config child until it exits', async () => {
    const ssh = fakeSsh(1, { configNeverCloses: true });
    const before = trackedChildCount();
    const controller = new AbortController();
    const fetch = createSshFetch(
      { destination: 'me@gpu', label: 'gpu' },
      { spawn: ssh.spawn, platform: 'linux', home: '/home/me', makeDir: async () => undefined }
    );
    const response = fetch(`${SSH_OLLAMA_URL}/api/version`, { signal: controller.signal });
    await vi.waitFor(() => expect(ssh.children).toHaveLength(1));
    expect(trackedChildCount()).toBe(before + 1);
    controller.abort();
    await expect(response).rejects.toThrow();
    finish(ssh.children[0], 1);
    await vi.waitFor(() => expect(trackedChildCount()).toBe(before));
  });

  it('is read once and kept for the next request when the first request is aborted while it runs', async () => {
    const ssh = fakeSsh(await ollama(), { configDelayMs: 100 });
    const fetch = createSshFetch(
      { destination: 'me@gpu', label: 'gpu' },
      { spawn: ssh.spawn, platform: 'linux', home: '/home/me', makeDir: async () => undefined }
    );
    await expect(fetch(`${SSH_OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(20) })).rejects.toThrow();
    expect(ssh.spawned.map(call => call.args[0])).toEqual(['-G']);
    expect(await (await fetch(`${SSH_OLLAMA_URL}/api/version`)).json()).toEqual({ version: '0.12.0' });
    expect(ssh.spawned.filter(call => call.args[0] === '-G')).toHaveLength(1);
    expect(ssh.spawned.find(call => call.args.includes('-W'))?.args).toContain('ControlPath=~/.ssh/b4m/%C');
  });

  describe.skipIf(process.platform === 'win32')('when it runs past its limit', () => {
    let dir: string;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    afterEach(async () => {
      vi.useRealTimers();
      const pid = Number(await readFile(path.join(dir, 'grandchild.pid'), 'utf8').catch(() => ''));
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
      await rm(dir, { recursive: true, force: true });
    });

    it('ends a grandchild that holds its output open, and closes the pipes', async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-ssh-g-'));
      const command = path.join(dir, 'ssh');
      // As a `Match exec` command that outlives ssh: a background child holding ssh's stdout and stderr.
      await writeFile(
        command,
        '#!/bin/sh\nif [ "$1" = "-G" ]; then\n  sleep 300 &\n  echo $! > "$(dirname "$0")/grandchild.pid"\n  wait\nfi\nexit 255\n'
      );
      await chmod(command, 0o755);
      const children: ChildProcess[] = [];
      const spawn: SshDeps['spawn'] = (file, args, options) => {
        const child = spawnChild(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
        children.push(child);
        return child;
      };
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const fetch = createSshFetch(
        { destination: 'me@gpu', label: 'gpu' },
        { command, spawn, platform: 'linux', home: '/home/me', makeDir: async () => undefined }
      );
      const response = fetch(`${SSH_OLLAMA_URL}/api/version`);
      response.catch(() => undefined);
      const pidFile = path.join(dir, 'grandchild.pid');
      const grandchild = await vi.waitFor(
        async () => {
          const pid = Number(await readFile(pidFile, 'utf8'));
          expect(pid).toBeGreaterThan(0);
          return pid;
        },
        { timeout: 5_000 }
      );
      await vi.advanceTimersByTimeAsync(CONFIG_TIMEOUT_MS);
      vi.useRealTimers();
      await expect(response).rejects.toThrow();
      await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 5_000 });
      expect(children[0].stdout?.destroyed).toBe(true);
      expect(children[0].stderr?.destroyed).toBe(true);
    });
  });
});
