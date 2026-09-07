import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionActorName } from './identity';
import {
  PRESENCE_PAYLOAD_SCHEMA_NAME,
  PRESENCE_SURFACES,
  presencePayloadSchema,
  type PresencePayload,
} from './presence';

describe('presencePayloadSchema', () => {
  it('accepts the full field set both reporters can write', () => {
    const payload: PresencePayload = {
      hook_event_name: 'PreToolUse',
      session_id: 'a67cd606-80f3-459d-88b5-3df6d3c11a31',
      slug: 'amber-otter',
      workspace: 'somerepo',
      surface: 'cc-bridge',
      source: 'claude',
      claude_version: '2.1.0',
      activity: {
        reason: 'tool_use',
        tool: 'Bash',
        permission_mode: 'default',
        effort: 'high',
        duration_ms: 1200,
        subagent: 'Explore',
        background_tasks: 2,
      },
    };
    expect(presencePayloadSchema.parse(payload)).toEqual(payload);
  });

  // A tier-0 hook forwards neither workspace nor activity, and a hand-posted
  // event may carry nothing at all. Both must still refresh lastSeen rather
  // than being rejected into a skipped roster write.
  it('accepts an empty payload and a payload with no activity block', () => {
    expect(presencePayloadSchema.safeParse({}).success).toBe(true);
    expect(presencePayloadSchema.safeParse({ hook_event_name: 'SessionEnd' }).success).toBe(true);
  });

  it('drops unknown keys instead of failing the parse', () => {
    const parsed = presencePayloadSchema.parse({ slug: 'amber-otter', future_field: 'ignored' });
    expect(parsed).toEqual({ slug: 'amber-otter' });
  });

  // The whole point of the loose string: a fourth reporter must land on the
  // roster with its detail intact. A strict enum would fail the parse and drop
  // the row entirely - the cost this shared contract exists to remove.
  it('accepts an unrecognized surface', () => {
    const parsed = presencePayloadSchema.safeParse({ surface: 'some-future-gateway', slug: 'amber-otter' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.surface).toBe('some-future-gateway');
  });
});

/**
 * Drift guard against the hook's literal copies of these constants, the same
 * arrangement as the slug parity test in identity.test.ts: the hook runs under
 * bare `node` with no imports, so it restates the schema name, its surface tag
 * and the actor-name convention, and the only defense against divergence is to
 * run it and compare what it puts on the wire.
 */
const HOOK_PATH = fileURLToPath(new URL('../../../packages/cli/bin/hearth-hook.mjs', import.meta.url));

interface CapturedBody {
  machine: { schema: string; payload: PresencePayload };
  actor: { kind: string; displayName: string };
}

function captureHookBody(sessionId: string): Promise<CapturedBody> {
  return new Promise((resolve, reject) => {
    let captured: CapturedBody | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        captured = JSON.parse(Buffer.concat(chunks).toString() || '{}') as CapturedBody;
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

describe('hearth-hook.mjs presence contract parity', () => {
  const SESSION = 'a67cd606-80f3-459d-88b5-3df6d3c11a31';

  it('writes the shared schema name and a recognized surface, and its payload parses', async () => {
    const body = await captureHookBody(SESSION);

    expect(body.machine.schema).toBe(PRESENCE_PAYLOAD_SCHEMA_NAME);
    expect(PRESENCE_SURFACES).toContain(body.machine.payload.surface);
    expect(presencePayloadSchema.safeParse(body.machine.payload).success).toBe(true);
  }, 15000);

  // The convergence itself: the bridge names the same session via
  // sessionActorName, and ensureActor upserts on displayName, so any
  // disagreement here splits one session into two actors and two roster rows.
  it('names its actor exactly as sessionActorName does', async () => {
    const body = await captureHookBody(SESSION);

    expect(body.actor.kind).toBe('agent');
    expect(body.actor.displayName).toBe(sessionActorName(SESSION));
  }, 15000);
});
