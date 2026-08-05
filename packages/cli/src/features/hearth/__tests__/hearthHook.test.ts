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

/**
 * Deliberately loaded with every content-bearing field the hook docs define,
 * each carrying a unique bait string, so a leak at ANY tier fails loudly rather
 * than depending on the author having guessed which field to check.
 */
const HOOK_INPUT = {
  hook_event_name: 'Stop',
  session_id: 'sess-123',
  // The BASENAME is legitimate tier-1 disclosure; every parent segment is not.
  // Separating them lets the tier assertions below check both directions.
  cwd: '/Users/someone/BAIT-parent-dir/workspace-name',
  transcript_path: '/Users/someone/.claude/projects/x/transcript-BAIT.jsonl',
  message: 'Claude finished responding about /Users/someone/BAIT-parent-dir/creds.env',
  last_assistant_message: 'BAIT-assistant-reply',
  prompt: 'BAIT-user-prompt',
  tool_input: { file_path: '/Users/someone/BAIT-tool-input' },
  tool_response: 'BAIT-tool-response',
  compact_summary: 'BAIT-compact-summary',
  custom_instructions: 'BAIT-custom-instructions',
  background_tasks: [{ id: 't1', type: 'shell', status: 'running', command: 'BAIT-task-command' }],
  permission_mode: 'default',
  stop_hook_active: false,
};

/** Every bait value that must never appear anywhere in the wire body, at any tier. */
const BAIT = [
  'BAIT-parent-dir',
  'transcript-BAIT',
  'BAIT-assistant-reply',
  'BAIT-user-prompt',
  'BAIT-tool-input',
  'BAIT-tool-response',
  'BAIT-compact-summary',
  'BAIT-custom-instructions',
  'BAIT-task-command',
  'creds.env',
];

const HOOK_ENV = (port: number) => ({
  B4M_API_URL: `http://127.0.0.1:${port}`,
  B4M_API_KEY: 'test-key',
  B4M_HEARTH_CHANNEL: 'ch-1',
});

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
      expect(machine.schema).toBe('hearth.presence@1');
      // Default tier is 2: identity + workspace basename + activity state.
      // `surface` is a constant reporter tag, so it discloses nothing about the
      // environment and travels at every tier.
      expect(Object.keys(machine.payload).sort()).toEqual([
        'activity',
        'hook_event_name',
        'session_id',
        'slug',
        'surface',
        'workspace',
      ]);
      expect(machine.payload.surface).toBe('claude-code-hook');

      // No content-bearing field survives anywhere in the wire body.
      const wire = JSON.stringify(body);
      for (const bait of BAIT) {
        expect(wire, `leaked ${bait}`).not.toContain(bait);
      }
    } finally {
      close();
    }
  }, 15000);

  it('discloses exactly the documented field set at each tier', async () => {
    // `surface` is present at every tier: it is a constant naming the reporter,
    // so it discloses nothing about the session's environment.
    const expectedKeys: Record<string, string[]> = {
      '0': ['hook_event_name', 'session_id', 'slug', 'surface'],
      '1': ['hook_event_name', 'session_id', 'slug', 'surface', 'workspace'],
      '2': ['activity', 'hook_event_name', 'session_id', 'slug', 'surface', 'workspace'],
    };

    for (const [tier, keys] of Object.entries(expectedKeys)) {
      const { port, captured, close } = await startCaptureServer();
      try {
        await runHook({ ...HOOK_ENV(port), B4M_HEARTH_DISCLOSURE: tier }, HOOK_INPUT);
        const machine = captured.current!.body.machine as { payload: Record<string, unknown> };
        expect(Object.keys(machine.payload).sort(), `tier ${tier}`).toEqual(keys);

        // Bait must never leak, at any tier.
        const wire = JSON.stringify(captured.current!.body);
        for (const bait of BAIT) {
          expect(wire, `tier ${tier} leaked ${bait}`).not.toContain(bait);
        }

        // The workspace basename is disclosed from tier 1 up, and NOT at tier 0.
        if (tier === '0') {
          expect(wire, 'tier 0 must disclose no workspace').not.toContain('workspace-name');
        } else {
          expect(machine.payload.workspace, `tier ${tier} workspace`).toBe('workspace-name');
        }
      } finally {
        close();
      }
    }
  }, 30000);

  it('clamps an out-of-range or malformed tier into range, never wider than the max', async () => {
    const TIER_2 = ['activity', 'hook_event_name', 'session_id', 'slug', 'surface', 'workspace'];
    const TIER_0 = ['hook_event_name', 'session_id', 'slug', 'surface'];
    // Above the max clamps to the max; below zero clamps to the minimum;
    // unparseable resolves to the MINIMUM, because a broken privacy setting must
    // fail closed. Only genuinely unset gets the default (asserted separately).
    const cases: Array<[string, string[]]> = [
      ['99', TIER_2],
      ['-5', TIER_0],
      // Unparseable means MINIMUM, not default. This case previously asserted
      // TIER_2 and so pinned the fail-open in place: `none`, `off`, `min`,
      // `zero`, `"0"`, and an unexpanded `$LEVEL` all land here, and every one
      // of them is somebody reaching for less disclosure.
      ['banana', TIER_0],
      ['none', TIER_0],
      ['off', TIER_0],
      ['$UNEXPANDED', TIER_0],
    ];

    for (const [raw, keys] of cases) {
      const { port, captured, close } = await startCaptureServer();
      try {
        await runHook({ ...HOOK_ENV(port), B4M_HEARTH_DISCLOSURE: raw }, HOOK_INPUT);
        const machine = captured.current!.body.machine as { payload: Record<string, unknown> };
        expect(Object.keys(machine.payload).sort(), `raw ${raw}`).toEqual(keys);
      } finally {
        close();
      }
    }
  }, 30000);

  it('normalizes activity from notification_type, not from the raw message', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      await runHook(HOOK_ENV(port), {
        hook_event_name: 'Notification',
        session_id: 'sess-123',
        notification_type: 'permission_prompt',
        tool_name: 'Bash',
        // The raw message carries a path; the reason must come from the
        // machine-readable classifier and this string must not be echoed.
        message: 'Claude needs your permission to run /Users/someone/secret-project/deploy.sh',
        permission_mode: 'default',
        effort: { level: 'high' },
        duration_ms: 1234,
      });

      const body = captured.current!.body;
      const activity = (body.machine as { payload: { activity: Record<string, unknown> } }).payload.activity;
      expect(activity).toEqual({
        reason: 'permission_prompt',
        tool: 'Bash',
        permission_mode: 'default',
        effort: 'high',
        duration_ms: 1234,
      });

      // The human line is composed here, never passed through from upstream.
      expect(body.human).toMatchObject({ format: 'text' });
      const text = (body.human as { text: string }).text;
      expect(text).toContain('needs permission: Bash');
      expect(text).not.toContain('deploy.sh');
      expect(JSON.stringify(body)).not.toContain('secret-project');
    } finally {
      close();
    }
  }, 15000);

  it('gives each session a stable, distinct actor identity', async () => {
    const identityFor = async (sessionId: string) => {
      const { port, captured, close } = await startCaptureServer();
      try {
        await runHook(HOOK_ENV(port), { ...HOOK_INPUT, session_id: sessionId });
        const body = captured.current!.body;
        return {
          actor: body.actor as { kind: string; displayName: string },
          slug: (body.machine as { payload: { slug: string } }).payload.slug,
        };
      } finally {
        close();
      }
    };

    const first = await identityFor('a67cd606-80f3-459d-88b5-3df6d3c11a31');
    const again = await identityFor('a67cd606-80f3-459d-88b5-3df6d3c11a31');
    const other = await identityFor('df990e39-ab42-4b25-99ff-be8107c80349');

    // Stable across runs: same session, same slug and actor.
    expect(again).toEqual(first);
    // Distinct per session, which is what gives each one its own cursor.
    expect(other.slug).not.toBe(first.slug);
    // Always an agent actor, never the account's human actor.
    expect(first.actor.kind).toBe('agent');
    // The slug alone, matching sessionActorName, which the cc-bridge also uses:
    // the two reporters cover the same sessions, and ensureActor upserts on
    // displayName, so disagreeing here splits one session into two actors.
    expect(first.actor.displayName).toBe(first.slug);
    // Readable rather than hex.
    expect(first.slug).toMatch(/^[a-z]+-[a-z]+$/);
  }, 30000);

  it('honors an explicit B4M_HEARTH_LABEL over the derived slug', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      await runHook({ ...HOOK_ENV(port), B4M_HEARTH_LABEL: 'phase-4 telegram' }, HOOK_INPUT);
      const body = captured.current!.body;
      expect((body.actor as { displayName: string }).displayName).toBe('phase-4 telegram');
      // The derived slug still travels in the payload for correlation.
      expect((body.machine as { payload: { slug: string } }).payload.slug).toMatch(/^[a-z]+-[a-z]+$/);
    } finally {
      close();
    }
  }, 15000);

  it('addresses the shared default channel by NAME when no channel id is configured', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      // B4M_HEARTH_CHANNEL is optional: without it a fresh install still reports,
      // into the same channel the cc-bridge uses, so one roster covers both.
      await runHook({ B4M_API_URL: `http://127.0.0.1:${port}`, B4M_API_KEY: 'test-key' }, HOOK_INPUT);
      const body = captured.current!.body;
      expect(body.channelName).toBe('agents');
      expect(body.channelId).toBeUndefined();
    } finally {
      close();
    }
  }, 15000);

  it('prefers an explicit channel id over the default name', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      await runHook(HOOK_ENV(port), HOOK_INPUT);
      const body = captured.current!.body;
      expect(body.channelId).toBe('ch-1');
      expect(body.channelName).toBeUndefined();
    } finally {
      close();
    }
  }, 15000);

  it('exits 0 without any request when credentials are missing (fail-silent contract)', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      // The channel is optional now, but the credentials are not.
      const exitCode = await runHook({ B4M_API_URL: `http://127.0.0.1:${port}`, B4M_API_KEY: '' }, HOOK_INPUT);
      expect(exitCode).toBe(0);
      expect(captured.current).toBeUndefined();
    } finally {
      close();
    }
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
