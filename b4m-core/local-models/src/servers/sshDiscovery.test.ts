import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROBE_HOSTS } from '../detect';
import { createSshFetch, type SshDeps } from './ssh';
import { discoverSshServers, SSH_DISCOVERY_PORTS } from './sshDiscovery';

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
  await Promise.all(
    servers.splice(0).map(server => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    })
  );
});

type Route = (req: http.IncomingMessage) => { status?: number; body: unknown; type?: string } | null;

async function serve(route: Route): Promise<number> {
  const server = http.createServer((req, res) => {
    const answer = route(req) ?? { status: 404, body: { error: 'not found' } };
    res.writeHead(answer.status ?? 200, { 'content-type': answer.type ?? 'application/json' });
    res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const ollama = () =>
  serve(req =>
    req.url === '/api/version'
      ? { body: { version: '0.12.0' } }
      : req.url === '/api/tags'
        ? { body: { models: [{ name: 'qwen3:8b' }, { name: 'gemma3:4b' }] } }
        : null
  );

/** An OpenAI-compatible server listing `count` models owned by `owner`, with the product endpoints it names. */
function openAI(owner: string, count = 1, opts: { token?: string; lmStudio?: boolean } = {}) {
  return serve(req => {
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      return { status: 401, body: { error: { code: 401, message: 'Invalid API Key', type: 'authentication_error' } } };
    }
    if (req.url === '/v1/models') {
      return {
        body: {
          object: 'list',
          data: Array.from({ length: count }, (_, index) => ({
            id: `model-${index}`,
            object: 'model',
            owned_by: owner,
          })),
        },
      };
    }
    if (req.url === '/props' && owner === 'llamacpp') return { body: { build_info: 'b6000-abc' } };
    if (req.url === '/version' && owner === 'vllm') return { body: { version: '0.11.0' } };
    if (req.url === '/api/v0/models' && opts.lmStudio) return { body: { object: 'list', data: [] } };
    return null;
  });
}

/** Sends the headers and the start of a model list on /v1/models, then nothing more. */
async function stalling(): Promise<number> {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' });
    if (req.url === '/v1/models') res.write('{"data":[');
    else res.end('{}');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const loginPage = () => serve(() => ({ status: 401, body: '<html>Sign in</html>', type: 'text/html' }));
const dashboard = () => serve(() => ({ body: '<html>Dashboard</html>', type: 'text/html' }));

type FarEnd = Record<number, number>;

/**
 * A stand-in for ssh: `-W 127.0.0.1:<port>` reaches the local server `farEnd[port]` maps to, the way the forward
 * reaches the far end's loopback, and fails as ssh does when nothing listens there. `stderr` fails every forward.
 */
function fakeSsh(
  farEnd: FarEnd,
  opts: {
    stderr?: string;
    shared?: boolean;
    hang?: boolean;
    loginMs?: number;
    eachMs?: number;
    configNeverCloses?: boolean;
  } = {}
) {
  const forwards: { port: number; at: number; child: FakeChild; spawnedAt: number }[] = [];
  let answered = -1;
  const spawn: SshDeps['spawn'] = (_command, args) => {
    const child = fakeChild();
    if (args[0] === '-G' && opts.configNeverCloses) {
      child.kill = vi.fn(() => true) as never;
      return child;
    }
    if (args[0] === '-G') {
      setImmediate(() => {
        child.stdout.write('user me\n');
        finish(child, 0);
      });
      return child;
    }
    const target = args[args.indexOf('-W') + 1];
    const port = Number(target.split(':')[1]);
    forwards.push({ port, at: forwards.length, child, spawnedAt: performance.now() });
    if (opts.hang) return child;
    const local = farEnd[port];
    const fail = (stderr: string) =>
      setImmediate(() => {
        child.stderr.write(stderr);
        finish(child, 255);
      });
    if (opts.stderr) {
      fail(opts.stderr);
      return child;
    }
    if (local === undefined) {
      fail(
        opts.shared
          ? 'Stdio forwarding request failed: Session open refused by peer\n'
          : `channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed\n`
      );
      return child;
    }
    const connect = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const socket = net.connect(local, '127.0.0.1');
      child.stdin.pipe(socket);
      socket.on('data', chunk => {
        if (answered < 0) answered = forwards.length;
        child.stdout.write(chunk);
      });
      socket.on('end', () => finish(child, 0));
      socket.on('error', () => finish(child, 255));
      child.on('close', () => socket.destroy());
    };
    // The first forward also logs in; the rest ride its connection.
    const delay = forwards.length === 1 ? opts.loginMs : opts.eachMs;
    if (delay) setTimeout(connect, delay);
    else connect();
    return child;
  };
  return { spawn, forwards, spawnedBeforeFirstAnswer: () => answered };
}

function discover(
  farEnd: FarEnd,
  opts: Parameters<typeof fakeSsh>[1] & {
    port?: number;
    deadlineMs?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  } = {}
) {
  const ssh = fakeSsh(farEnd, opts);
  const result = discoverSshServers({
    destination: 'me@gpu',
    port: opts.port,
    deadlineMs: opts.deadlineMs,
    requestTimeoutMs: opts.requestTimeoutMs,
    signal: opts.signal,
    now: () => performance.now(),
    fetchFor: port =>
      createSshFetch({ destination: 'me@gpu', label: 'gpu', port }, { spawn: ssh.spawn, platform: 'win32' }),
  });
  return { ssh, result };
}

describe('discoverSshServers', () => {
  it('probes the same ports as local detection', () => {
    expect(SSH_DISCOVERY_PORTS.map(({ port }) => `127.0.0.1:${port}`)).toEqual([...DEFAULT_PROBE_HOSTS]);
  });

  it('finds one Ollama and reports its kind, version and model count', async () => {
    const { result } = discover({ 11434: await ollama() });
    expect(await result).toEqual({
      found: [
        {
          port: 11434,
          kind: 'ollama',
          product: null,
          version: '0.12.0',
          models: 2,
          latencyMs: expect.any(Number),
          needsCredentials: false,
        },
      ],
      error: null,
      refused: false,
    });
  });

  it('finds every kind at once, each with its product, in port order', async () => {
    const { result } = discover({
      11434: await ollama(),
      1234: await openAI('organization_owner', 2, { lmStudio: true }),
      8080: await openAI('llamacpp'),
      8000: await openAI('vllm', 3),
    });
    const { found, error } = await result;
    expect(error).toBeNull();
    expect(found.map(server => [server.port, server.kind, server.product, server.version, server.models])).toEqual([
      [11434, 'ollama', null, '0.12.0', 2],
      [1234, 'openai-compatible', 'lmstudio', null, 2],
      [8080, 'openai-compatible', 'llama-server', 'b6000-abc', 1],
      [8000, 'openai-compatible', 'vllm', '0.11.0', 3],
    ]);
  });

  it('recognizes llama-swap by its owned_by and counts a long model list', async () => {
    const { result } = discover({ 8080: await openAI('llama-swap', 250) });
    expect((await result).found).toEqual([expect.objectContaining({ port: 8080, product: 'llama-swap', models: 250 })]);
  });

  it('keeps a server it cannot name as generic OpenAI-compatible', async () => {
    const { result } = discover({ 8000: await openAI('someone-else') });
    expect((await result).found).toEqual([
      expect.objectContaining({ port: 8000, kind: 'openai-compatible', product: null }),
    ]);
  });

  it('logs in with one request before the rest start, so they can share its connection', async () => {
    const { ssh, result } = discover({ 11434: await ollama(), 8080: await openAI('llamacpp') });
    await result;
    expect(ssh.forwards[0].port).toBe(11434);
    expect(ssh.spawnedBeforeFirstAnswer()).toBe(1);
    expect(new Set(ssh.forwards.map(forward => forward.port))).toEqual(new Set([11434, 1234, 8080, 8000]));
  });

  it('reports a server that wants a key without sending one', async () => {
    const { result } = discover({ 8080: await openAI('llamacpp', 1, { token: 'sk-x' }) });
    expect((await result).found).toEqual([
      expect.objectContaining({ port: 8080, kind: 'openai-compatible', needsCredentials: true }),
    ]);
  });

  it('does not take a login page on a usual port for a model server', async () => {
    const { result } = discover({ 8080: await loginPage(), 8000: await dashboard() });
    const { found, error } = await result;
    expect(found).toEqual([]);
    expect(error).toMatch(/^SSH to me@gpu works, but no model server answers on the usual ports there/);
    expect(error).toContain('Port 8080 and 8000 answered, but not as Ollama or an OpenAI-compatible server.');
  });

  it('names the usual ports and what to do when nothing answers', async () => {
    const { result } = discover({});
    expect(await result).toEqual({
      found: [],
      error:
        'SSH to me@gpu works, but no model server answers on the usual ports there (Ollama 11434, LM Studio 1234, llama-server 8080, vLLM 8000). Start the server on that machine, or enter the port it listens on.',
      refused: false,
    });
  });

  it('adds the forwarding setting when a shared connection cannot tell a stopped server from a refused forward', async () => {
    const { result } = discover({}, { shared: true });
    expect((await result).error).toMatch(
      /enter the port it listens on\. If a server is running there.*AllowTcpForwarding/
    );
  });

  it('probes only a custom port', async () => {
    const { ssh, result } = discover({ 9000: await openAI('llama-swap'), 11434: await ollama() }, { port: 9000 });
    expect((await result).found).toEqual([expect.objectContaining({ port: 9000, product: 'llama-swap' })]);
    expect(new Set(ssh.forwards.map(forward => forward.port))).toEqual(new Set([9000]));
  });

  it('says what to do when a custom port has nothing or something else on it', async () => {
    expect((await discover({}, { port: 9000 }).result).error).toBe(
      'SSH to me@gpu works, but nothing answers at 127.0.0.1:9000 there. Start the model server on that machine, or check its port.'
    );
    expect((await discover({ 9000: await dashboard() }, { port: 9000 }).result).error).toBe(
      'Something answers at 127.0.0.1:9000 on me@gpu, but not as Ollama or an OpenAI-compatible server. Check the port.'
    );
  });

  it('takes a 401 on a custom port as a server that wants a key', async () => {
    const { result } = discover({ 9000: await loginPage() }, { port: 9000 });
    expect((await result).found).toEqual([expect.objectContaining({ port: 9000, needsCredentials: true })]);
  });

  it('stops after a refused login and says how to fix it, without trying the other ports', async () => {
    const { ssh, result } = discover({ 11434: await ollama() }, { stderr: 'me@gpu: Permission denied (publickey).\n' });
    const outcome = await result;
    expect(outcome).toMatchObject({ found: [], refused: true });
    expect(outcome.error).toMatch(/me@gpu refused the SSH login\. Check that `ssh me@gpu` works/);
    expect(ssh.forwards).toHaveLength(1);
  });

  it('stops after a connection failure, which a later check may get past', async () => {
    const { ssh, result } = discover(
      { 11434: await ollama() },
      { stderr: 'ssh: connect to host gpu port 22: Connection timed out\n' }
    );
    expect(await result).toEqual({
      found: [],
      error: 'ssh me@gpu failed: ssh: connect to host gpu port 22: Connection timed out',
      refused: false,
    });
    expect(ssh.forwards).toHaveLength(1);
  });

  it('gives up at the deadline and names what to check', async () => {
    const { result } = discover({ 11434: await ollama() }, { hang: true, deadlineMs: 50 });
    expect(await result).toEqual({
      found: [],
      error: 'me@gpu did not answer within 1 s. Check that `ssh me@gpu` connects from a terminal, then test again.',
      refused: false,
    });
  });

  it('counts each request from when it starts, not while it waits behind a slow login', async () => {
    const { result } = discover(
      { 11434: await ollama(), 8080: await openAI('llamacpp') },
      { loginMs: 300, eachMs: 250, requestTimeoutMs: 400, deadlineMs: 5_000 }
    );
    const { found, error } = await result;
    expect(error).toBeNull();
    expect(found.map(server => [server.port, server.kind])).toEqual([
      [11434, 'ollama'],
      [8080, 'openai-compatible'],
    ]);
  });

  it('does not count a limit that ran out after its request had its answer', async () => {
    const { result } = discover(
      { 8080: await loginPage() },
      { loginMs: 250, eachMs: 250, requestTimeoutMs: 400, deadlineMs: 5_000 }
    );
    const { error } = await result;
    expect(error).toContain('Port 8080 answered, but not as Ollama or an OpenAI-compatible server.');
    expect(error).not.toContain('did not answer within');
  });

  it('stops after a first request that runs out its limit, so ssh is not started again for every port', async () => {
    const { ssh, result } = discover(
      { 11434: await ollama() },
      { hang: true, requestTimeoutMs: 1_000, deadlineMs: 10_000 }
    );
    expect((await result).error).toBe(
      'ssh me@gpu did not finish connecting, or 127.0.0.1:11434 there did not answer, within 1 s. Run `ssh me@gpu` in a terminal to check that it connects. If it does, restart that server, or enter the port of the one you want, then test again.'
    );
    expect(ssh.forwards).toHaveLength(1);
    expect(alive(ssh)).toEqual([]);
  });

  it('on a port the user entered, advises restarting that server and names the port, 80 included', async () => {
    for (const port of [9000, 80]) {
      const { ssh, result } = discover({}, { port, hang: true, requestTimeoutMs: 1_000, deadlineMs: 10_000 });
      expect((await result).error).toBe(
        `ssh me@gpu did not finish connecting, or 127.0.0.1:${port} there did not answer, within 1 s. Run \`ssh me@gpu\` in a terminal to check that it connects. If it does, restart that server, then test again.`
      );
      expect(alive(ssh)).toEqual([]);
    }
  });

  it('names the per-request limit when a reply stalls past it, and leaves no ssh running', async () => {
    const started = performance.now();
    const { ssh, result } = discover({ 9000: await stalling() }, { port: 9000, requestTimeoutMs: 400 });
    expect((await result).error).toBe(
      'me@gpu did not answer within 1 s. Check that `ssh me@gpu` connects from a terminal, then test again.'
    );
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(alive(ssh)).toEqual([]);
  });

  it('names the deadline when it is the limit a stalled reply runs into', async () => {
    const started = performance.now();
    const { ssh, result } = discover(
      { 9000: await stalling() },
      { port: 9000, requestTimeoutMs: 10_000, deadlineMs: 2_000 }
    );
    expect((await result).error).toBe(
      'me@gpu did not answer within 2 s. Check that `ssh me@gpu` connects from a terminal, then test again.'
    );
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(alive(ssh)).toEqual([]);
  });

  function alive(ssh: ReturnType<typeof fakeSsh>) {
    return ssh.forwards.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  }

  it('returns within its deadline while ssh -G never closes, and starts no forward', async () => {
    const ssh = fakeSsh({ 11434: await ollama() }, { configNeverCloses: true });
    const started = performance.now();
    const result = await discoverSshServers({
      destination: 'me@gpu',
      deadlineMs: 300,
      now: () => performance.now(),
      fetchFor: port =>
        createSshFetch(
          { destination: 'me@gpu', label: 'gpu', port },
          { spawn: ssh.spawn, platform: 'linux', home: '/home/me', makeDir: async () => undefined }
        ),
    });
    expect(result.found).toEqual([]);
    expect(result.error).toContain('did not answer within');
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(ssh.forwards).toEqual([]);
  });

  it('starts no ssh after the deadline and leaves none running', async () => {
    const { ssh, result } = discover({ 11434: await ollama() }, { hang: true, deadlineMs: 50 });
    const started = performance.now();
    expect((await result).error).toContain('did not answer within');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ssh.forwards).toHaveLength(1);
    expect(ssh.forwards.every(({ spawnedAt }) => spawnedAt < started + 50)).toBe(true);
    expect(alive(ssh)).toEqual([]);
  });

  it('stops when cancelled: rejects with the reason, starts no more ssh and leaves none running', async () => {
    const cancel = new AbortController();
    const { ssh, result } = discover({ 11434: await ollama() }, { hang: true, signal: cancel.signal });
    await vi.waitFor(() => expect(ssh.forwards).toHaveLength(1));
    const reason = new DOMException('Cancelled', 'AbortError');
    cancel.abort(reason);
    await expect(result).rejects.toBe(reason);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ssh.forwards).toHaveLength(1);
    expect(alive(ssh)).toEqual([]);
  });

  it('starts nothing when cancelled before it begins', async () => {
    const cancel = new AbortController();
    cancel.abort(new DOMException('Cancelled', 'AbortError'));
    const { ssh, result } = discover({ 11434: await ollama() }, { signal: cancel.signal });
    await expect(result).rejects.toThrow('Cancelled');
    expect(ssh.forwards).toEqual([]);
  });
});
