import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HEARTH_CHANNEL_NAME, sessionSlug } from './identity';

describe('sessionSlug', () => {
  it('is stable per id, distinct across ids, and readable', () => {
    const id = 'a67cd606-80f3-459d-88b5-3df6d3c11a31';
    expect(sessionSlug(id)).toBe(sessionSlug(id));
    expect(sessionSlug(id)).toMatch(/^[a-z]+-[a-z]+$/);
    expect(sessionSlug(id)).not.toBe(sessionSlug('df990e39-ab42-4b25-99ff-be8107c80349'));
  });

  it('names a missing id rather than throwing', () => {
    expect(sessionSlug(undefined)).toBe('unknown-session');
    expect(sessionSlug('')).toBe('unknown-session');
  });
});

/**
 * Drift guard between this module and the SECOND copy of the same algorithm in
 * packages/cli/bin/hearth-hook.mjs. That copy exists because the hook runs under
 * bare `node` with no imports, so it cannot be deduplicated away - the only
 * defense against the two diverging is to run the hook and compare slugs.
 *
 * The hook is spawned by path rather than imported: it is an executable that
 * reads stdin and POSTs, so a capture server stands in for the API.
 */
const HOOK_PATH = fileURLToPath(new URL('../../../packages/cli/bin/hearth-hook.mjs', import.meta.url));

function captureSlugFromHook(sessionId: string): Promise<{ slug: string; channelName?: string }> {
  return new Promise((resolve, reject) => {
    let captured: { slug: string; channelName?: string } | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
          channelName?: string;
          machine: { payload: { slug: string } };
        };
        captured = { slug: body.machine.payload.slug, channelName: body.channelName };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"event":{}}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const child = spawn(process.execPath, [HOOK_PATH], {
        env: { ...process.env, B4M_API_URL: `http://127.0.0.1:${port}`, B4M_API_KEY: 'test-key' },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', err => {
        server.close();
        reject(err);
      });
      child.on('exit', () => {
        server.close();
        if (!captured) reject(new Error('hook sent no request'));
        else resolve(captured);
      });
      child.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }));
      child.stdin.end();
    });
  });
}

describe('hearth-hook.mjs parity', () => {
  it('derives the same slug as the hook for the same session id', async () => {
    const ids = [
      'a67cd606-80f3-459d-88b5-3df6d3c11a31',
      'df990e39-ab42-4b25-99ff-be8107c80349',
      '00000000-0000-0000-0000-000000000000',
      'short',
    ];

    for (const id of ids) {
      const fromHook = await captureSlugFromHook(id);
      expect(fromHook.slug, `slug for ${id}`).toBe(sessionSlug(id));
    }
  }, 40000);

  it('the hook defaults to the same channel name the server does', async () => {
    const { channelName } = await captureSlugFromHook('a67cd606-80f3-459d-88b5-3df6d3c11a31');
    expect(channelName).toBe(DEFAULT_HEARTH_CHANNEL_NAME);
  }, 15000);
});
