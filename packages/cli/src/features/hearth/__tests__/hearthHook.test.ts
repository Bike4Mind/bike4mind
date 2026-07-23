import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end privacy contract for bin/hearth-hook.mjs (an executable, so it is
 * exercised as a subprocess rather than imported). Claude Code hook payloads
 * carry cwd/transcript_path; the hook must forward ONLY the whitelisted fields
 * into the shared Hearth channel - a regression here publishes local
 * filesystem paths into a log that humans, agents, and gateways all read.
 */
const HOOK_PATH = fileURLToPath(new URL('../../../../bin/hearth-hook.mjs', import.meta.url));

interface CapturedRequest {
  url: string;
  apiKey: string | undefined;
  body: Record<string, unknown>;
}

function runHook(env: Record<string, string>, stdinPayload: unknown) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? -1));
    child.stdin.write(JSON.stringify(stdinPayload));
    child.stdin.end();
  });
}

function startCaptureServer(): Promise<{ port: number; captured: { current?: CapturedRequest }; close: () => void }> {
  const captured: { current?: CapturedRequest } = {};
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        captured.current = {
          url: req.url ?? '',
          apiKey: req.headers['x-api-key'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
        };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"event":{}}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, captured, close: () => server.close() });
    });
  });
}

const HOOK_INPUT = {
  hook_event_name: 'Stop',
  session_id: 'sess-123',
  cwd: '/Users/someone/secret-project',
  transcript_path: '/Users/someone/.claude/projects/x/transcript.jsonl',
  message: 'Claude finished responding',
  stop_hook_active: false,
};

describe('bin/hearth-hook.mjs privacy contract', () => {
  it('forwards ONLY the whitelisted fields; no paths cross the boundary', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      const exitCode = await runHook(
        {
          B4M_API_URL: `http://127.0.0.1:${port}`,
          B4M_API_KEY: 'test-key',
          B4M_HEARTH_CHANNEL: 'ch-1',
        },
        HOOK_INPUT
      );

      expect(exitCode).toBe(0);
      expect(captured.current).toBeDefined();
      const { url, apiKey, body } = captured.current!;

      expect(url).toBe('/api/hearth/events');
      expect(apiKey).toBe('test-key');
      expect(body.channelId).toBe('ch-1');
      expect(body.kind).toBe('presence');

      const machine = body.machine as { schema: string; payload: Record<string, unknown> };
      expect(machine.schema).toBe('hearth.claude-code-hook@1');
      // The whitelist IS the contract: exactly these keys, nothing else.
      expect(Object.keys(machine.payload).sort()).toEqual(['hook_event_name', 'session_id']);

      // Belt and braces: no path-bearing field survives anywhere in the wire body.
      const wire = JSON.stringify(body);
      expect(wire).not.toContain('secret-project');
      expect(wire).not.toContain('transcript');
      expect(wire).not.toContain('cwd');
    } finally {
      close();
    }
  }, 15000);

  it('exits 0 without any request when env is missing (fail-silent contract)', async () => {
    const exitCode = await runHook({ B4M_API_URL: '', B4M_API_KEY: '', B4M_HEARTH_CHANNEL: '' }, HOOK_INPUT);
    expect(exitCode).toBe(0);
  }, 15000);

  it('exits 0 even on malformed stdin (never blocks the session)', async () => {
    const { port, close } = await startCaptureServer();
    try {
      const child = spawn(process.execPath, [HOOK_PATH], {
        env: {
          ...process.env,
          B4M_API_URL: `http://127.0.0.1:${port}`,
          B4M_API_KEY: 'k',
          B4M_HEARTH_CHANNEL: 'ch',
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const exit = new Promise<number>(resolve => child.on('exit', code => resolve(code ?? -1)));
      child.stdin.write('this is not json{{{');
      child.stdin.end();
      expect(await exit).toBe(0);
    } finally {
      close();
    }
  }, 15000);
});
