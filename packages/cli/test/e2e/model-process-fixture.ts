import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL = 'acceptance-tiny:latest';
export const LAYER = `sha256:${'c'.repeat(64)}`;
const directory = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.resolve(directory, '../../bin/bike4mind-cli.mjs');

export async function until(check: () => boolean, detail: () => string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${detail()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export interface Invocation {
  child: ChildProcess;
  output: string;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
}

export async function processFixture() {
  await Promise.all(
    ['index.mjs', 'commands/modelsCommand.mjs', 'commands/headlessCommand.mjs'].map(file =>
      access(path.resolve(directory, '../../dist', file))
    )
  );
  const home = await mkdtemp(path.join(tmpdir(), 'b4m-model-process-'));
  const desktop = path.join(home, 'desktop');
  await mkdir(desktop);
  const children = new Set<Invocation>();
  const servers: ReturnType<typeof createServer>[] = [];
  const origins: string[] = [];
  let registry = '';
  const settingsFile = path.join(home, '.bike4mind/config.json');

  return {
    home,
    desktop,
    settingsFile,
    async settings(): Promise<Record<string, unknown>> {
      return JSON.parse(await readFile(settingsFile, 'utf8'));
    },
    async savedServers(records: unknown[]) {
      await writeFile(path.join(desktop, 'model-servers.json'), JSON.stringify({ servers: records }));
    },
    async server(handler: (url: string, body: Record<string, unknown>, response: ServerResponse) => void) {
      const server = createServer(async (request, response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          handler(request.url ?? '/', chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}, response);
        } catch (error) {
          response.writeHead(500);
          response.end(String(error));
        }
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture address');
      const origin = `http://127.0.0.1:${address.port}`;
      origins.push(origin);
      registry ||= origin;
      return origin;
    },
    start(args: string[]): Invocation {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, 'appdata'),
        LOCALAPPDATA: path.join(home, 'localappdata'),
        XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_DATA_HOME: path.join(home, 'data'),
        XDG_CACHE_HOME: path.join(home, 'cache'),
        TMPDIR: home,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        TERM: 'dumb',
        B4M_NO_PROJECT_CONFIG: '1',
        B4M_NO_REMOTE_SKILLS: '1',
        B4M_DESKTOP_USER_DATA: desktop,
        B4M_TEST_ORIGINS: JSON.stringify(origins),
        B4M_TEST_REGISTRY: registry,
      };
      const child = spawn(
        process.execPath,
        ['--require', path.join(directory, 'fixtures/model-network.cjs'), entrypoint, ...args],
        {
          cwd: home,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      const invocation = { child, output: '' } as Invocation;
      const capture = (chunk: Buffer) => {
        invocation.output += chunk.toString();
      };
      child.stdout!.on('data', capture);
      child.stderr!.on('data', capture);
      invocation.done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, output: invocation.output });
        });
      });
      children.add(invocation);
      return invocation;
    },
    async close() {
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all([...children].map(child => child.done.catch(() => {})));
      await Promise.all(
        servers.map(
          server =>
            new Promise<void>(resolve => {
              server.close(() => resolve());
              server.closeAllConnections();
            })
        )
      );
      await rm(home, { recursive: true, force: true });
    },
  };
}

export function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function ollama(url: string, body: Record<string, unknown>, response: ServerResponse, answer: string) {
  if (url === '/api/version') return json(response, { version: '0.34.0' });
  if (url === '/api/tags')
    return json(response, {
      models: [
        {
          name: MODEL,
          size: 1000,
          capabilities: ['completion', 'tools'],
          details: { family: 'llama', parameter_size: '1M', quantization_level: 'Q4_K_M' },
        },
      ],
    });
  if (url === '/api/show')
    return json(response, {
      capabilities: ['completion', 'tools'],
      model_info: { 'general.architecture': 'llama', 'llama.context_length': 4096 },
    });
  if (url === '/api/chat') {
    const message = {
      model: MODEL,
      message: { role: 'assistant', content: answer },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 5,
      eval_count: 3,
    };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify(message)}\n`);
      return;
    }
    return json(response, message);
  }
  return json(response, { error: `Unexpected fixture route: ${url}` }, 404);
}
