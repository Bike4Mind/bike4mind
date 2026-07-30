import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOOK_REASON, HOOK_EVENT_REASONS, reasonForHookEvent } from './hookEvents';

describe('reasonForHookEvent', () => {
  it('maps each known lifecycle event to its reason', () => {
    expect(reasonForHookEvent('SessionEnd')).toBe('session_end');
    expect(reasonForHookEvent('SessionStart')).toBe('session_start');
    expect(reasonForHookEvent('Stop')).toBe('turn_finished');
    expect(reasonForHookEvent('PreToolUse')).toBe('tool_use');
  });

  it('degrades an unknown or absent event name rather than inventing a reason', () => {
    expect(reasonForHookEvent('SomeFutureHook')).toBe(DEFAULT_HOOK_REASON);
    expect(reasonForHookEvent(undefined)).toBe(DEFAULT_HOOK_REASON);
    expect(reasonForHookEvent('')).toBe(DEFAULT_HOOK_REASON);
  });

  // These are legal strings on the wire, and a plain object literal lookup reads
  // them through Object.prototype: `constructor` would return the Object
  // function, which is truthy and so bypasses the default.
  it('does not read prototype keys as event names', () => {
    expect(reasonForHookEvent('constructor')).toBe(DEFAULT_HOOK_REASON);
    expect(reasonForHookEvent('__proto__')).toBe(DEFAULT_HOOK_REASON);
    expect(reasonForHookEvent('toString')).toBe(DEFAULT_HOOK_REASON);
  });
});

/**
 * Drift guard against the SECOND copy of this table inside
 * packages/cli/bin/hearth-hook.mjs, which exists because the hook runs under
 * bare `node` with no imports. Same arrangement, and same reason, as the slug
 * parity test in identity.test.ts: the only defense against divergence is to run
 * the hook and compare.
 */
const HOOK_PATH = fileURLToPath(new URL('../../../packages/cli/bin/hearth-hook.mjs', import.meta.url));

function captureReasonFromHook(eventName: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let captured: string | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
          machine: { payload: { activity?: { reason?: string } } };
        };
        captured = body.machine.payload.activity?.reason;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"event":{}}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const child = spawn(process.execPath, [HOOK_PATH], {
        env: {
          ...process.env,
          B4M_API_URL: `http://127.0.0.1:${port}`,
          B4M_API_KEY: 'test-key',
          // Tier 2 is where the hook attaches `activity` at all, and an ambient
          // value in the developer's shell would otherwise decide this test.
          B4M_HEARTH_DISCLOSURE: '2',
          B4M_HEARTH_CHANNEL: undefined,
          B4M_HEARTH_LABEL: undefined,
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', err => {
        server.close();
        reject(err);
      });
      child.on('exit', () => {
        server.close();
        resolve(captured);
      });
      child.stdin.write(JSON.stringify({ hook_event_name: eventName, session_id: 'parity-session' }));
      child.stdin.end();
    });
  });
}

describe('hearth-hook.mjs reason parity', () => {
  it('derives the same reason as the hook for every event in the table', async () => {
    for (const eventName of Object.keys(HOOK_EVENT_REASONS)) {
      expect(await captureReasonFromHook(eventName), `reason for ${eventName}`).toBe(reasonForHookEvent(eventName));
    }
  }, 60000);

  it('agrees on the fallback for an event neither side knows', async () => {
    expect(await captureReasonFromHook('SomeFutureHook')).toBe(DEFAULT_HOOK_REASON);
  }, 15000);
});
