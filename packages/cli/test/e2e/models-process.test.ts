import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json, LAYER, MODEL, ollama, processFixture, until } from './model-process-fixture.js';

let fixture: Awaited<ReturnType<typeof processFixture>>;
beforeEach(async () => {
  fixture = await processFixture();
});
afterEach(async () => {
  await fixture?.close();
});

function savedServer(id: string, name: string, baseUrl: string) {
  return {
    id,
    name,
    kind: 'ollama',
    transport: { type: 'http', baseUrl },
    access: 'manage',
    auth: { type: 'none' },
    models: [MODEL],
  };
}

async function succeeded(args: string[]) {
  const result = await fixture.start(args).done;
  expect(result, result.output).toMatchObject({ code: 0, signal: null });
  return result.output;
}

describe('models commands through the executable and fresh disk settings', () => {
  // Node forcibly terminates Windows children instead of delivering SIGINT.
  it.skipIf(process.platform === 'win32')(
    'cancels a streaming pull with OS SIGINT and resumes the retained partial bytes in a new process',
    { timeout: 60_000 },
    async () => {
      const partial = Buffer.from('part');
      let downloaded = Buffer.alloc(0);
      const starts: number[] = [];
      const pullBodies: Record<string, unknown>[] = [];
      let disconnected = false;
      const host = await fixture.server((url, body, response) => {
        if (url === '/registry-manifest')
          return json(response, {
            layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: LAYER, size: 10 }],
          });
        if (url !== '/api/pull') return ollama(url, body, response, 'unused');
        pullBodies.push(body);
        starts.push(downloaded.length);
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const frame = () =>
          `${JSON.stringify({ status: `pulling ${LAYER}`, digest: LAYER, total: 10, completed: downloaded.length })}\n`;
        response.write(frame());
        if (starts.length === 1) {
          downloaded = Buffer.from(partial);
          response.write(frame());
          response.on('close', () => {
            disconnected = true;
          });
        } else {
          downloaded = Buffer.concat([downloaded, Buffer.from('ialend')]);
          response.end(`${frame()}${JSON.stringify({ status: 'success' })}\n`);
        }
      });
      const args = ['models', 'pull', MODEL, '--ollama-host', host, '--offline', '--yes', '--accept-license'];
      const first = fixture.start(args);
      await until(
        () => first.output.includes(`pulling ${LAYER}`),
        () => first.output
      );
      expect(downloaded.equals(partial)).toBe(true);
      expect(first.child.kill('SIGINT')).toBe(true);
      const cancelled = await first.done;
      expect(cancelled, cancelled.output).toMatchObject({ code: 130, signal: null });
      expect(cancelled.output).toMatch(/Pull cancelled\..*pulling again resumes it/);
      await until(
        () => disconnected,
        () => 'cancelled pull socket remained connected'
      );
      const output = await succeeded(['models', 'pull', MODEL, '--offline', '--yes', '--accept-license']);
      expect(output).toContain('Already downloaded: 4 B; pulling the rest.');
      expect(output).toContain(`pulling ${LAYER}`);
      expect(output).toContain(`Pulled ${MODEL}`);
      expect(starts).toEqual([0, 4]);
      expect(downloaded.toString()).toBe('partialend');
      expect(pullBodies).toEqual([
        { model: MODEL, stream: true },
        { model: MODEL, stream: true },
      ]);
    }
  );

  it(
    'remembers models use --ollama-host on disk and uses it for a fresh signed-out headless run',
    { timeout: 60_000 },
    async () => {
      const chats: Record<string, unknown>[] = [];
      const marker = 'SAVED_OLLAMA_HOST_REPLY';
      const host = await fixture.server((url, body, response) => {
        if (url === '/api/chat') chats.push(body);
        ollama(url, body, response, marker);
      });
      expect(await succeeded(['models', 'use', MODEL, '--ollama-host', host])).toContain(`Default model: ${MODEL}`);
      expect(await fixture.settings()).toMatchObject({
        defaultModel: MODEL,
        localDefaultModel: MODEL,
        ollamaHost: host,
      });
      const output = await succeeded(['--prompt', 'Reply with the fixture response.', '--output-format', 'json']);
      expect(output).toContain(marker);
      expect(chats.length).toBeGreaterThan(0);
      expect(chats.every(body => body.model === MODEL)).toBe(true);
      expect(await fixture.settings()).not.toHaveProperty('authToken');
    }
  );

  it(
    'persists a server-qualified default and routes fresh signed-out headless chat past a same-name decoy',
    { timeout: 60_000 },
    async () => {
      const decoyChats: Record<string, unknown>[] = [];
      const chosenChats: Record<string, unknown>[] = [];
      const decoy = await fixture.server((url, body, response) => {
        if (url === '/api/chat') decoyChats.push(body);
        ollama(url, body, response, 'WRONG_DECOY_REPLY');
      });
      const chosen = await fixture.server((url, body, response) => {
        if (url === '/api/chat') chosenChats.push(body);
        ollama(url, body, response, 'CHOSEN_SERVER_REPLY');
      });
      await fixture.savedServers([
        savedServer('decoy', 'First server', decoy),
        savedServer('chosen', 'Chosen server', chosen),
      ]);
      expect(await succeeded(['models', 'use', MODEL, '--server', 'Chosen server'])).toContain(
        `Default model: ${MODEL} on Chosen server`
      );
      expect(await fixture.settings()).toMatchObject({
        defaultModel: `local:srv-chosen:${MODEL}`,
        localDefaultModel: `local:srv-chosen:${MODEL}`,
      });
      const output = await succeeded(['--prompt', 'Reply with the fixture response.', '--output-format', 'json']);
      expect(output).toContain('CHOSEN_SERVER_REPLY');
      expect(output).not.toContain('WRONG_DECOY_REPLY');
      expect(chosenChats.length).toBeGreaterThan(0);
      expect(chosenChats.every(body => body.model === MODEL)).toBe(true);
      expect(decoyChats).toEqual([]);
    }
  );
});
