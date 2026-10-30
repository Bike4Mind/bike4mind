import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename } from 'node:path';
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

/**
 * process.env minus every B4M_HEARTH_* key. A developer who actually uses the
 * hook has these set, and inheriting them makes the suite assert against their
 * configuration rather than the tier defaults this file exists to pin.
 */
function ambientHookEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('B4M_HEARTH_')));
}

function runHook(env: Record<string, string>, stdinPayload: unknown) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: { ...ambientHookEnv(), ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? -1));
    child.stdin.write(JSON.stringify(stdinPayload));
    child.stdin.end();
  });
}

/** Preload that destroys stdin with EIO; a directory as stdin only errors on some platforms. */
const STDIN_ERROR_PRELOAD =
  "data:text/javascript,setTimeout(()=>process.stdin.destroy(Object.assign(new Error('EIO'),{code:'EIO'})),100)";

/**
 * Preload that fills the stderr pipe and queues a write that never lands, so the
 * hook's own line cannot be flushed until someone reads. Paired with a parent
 * that never drains.
 */
const STALLED_STDERR_PRELOAD = "data:text/javascript,process.stderr.write('x'.repeat(1<<20))";

/**
 * Spawns the hook with stderr captured. `injectStdinError` leaves stdin open and
 * breaks it; `closedStderr` closes the read end so the child's writes hit EPIPE;
 * `stalledStderr` leaves a full pipe undrained and kills the child if it has not
 * exited on its own, so a hang fails the assertion instead of the test timeout.
 */
function runHookCapturing(
  env: Record<string, string>,
  opts: {
    injectStdinError?: boolean;
    closedStderr?: boolean;
    stalledStderr?: boolean;
    stdinPayload?: string;
    preloads?: string[];
  } = {}
) {
  return new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    const preloads = [
      opts.injectStdinError ? STDIN_ERROR_PRELOAD : '',
      opts.stalledStderr ? STALLED_STDERR_PRELOAD : '',
      ...(opts.preloads ?? []).map(source => `data:text/javascript,${encodeURIComponent(source)}`),
    ]
      .filter(Boolean)
      .flatMap(source => ['--import', source]);
    const child = spawn(process.execPath, [...preloads, HOOK_PATH], {
      env: { ...ambientHookEnv(), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    if (opts.closedStderr) child.stderr.destroy();
    else if (opts.stalledStderr) child.stderr.pause();
    else child.stderr.on('data', c => (stderr += c));
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 4000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(watchdog);
      resolve({ code: code ?? -1, stderr, stdout });
    });
    if (!opts.injectStdinError) {
      child.stdin.write(opts.stdinPayload ?? JSON.stringify(HOOK_INPUT));
      child.stdin.end();
    }
  });
}

function startCaptureServer(
  status = 201
): Promise<{ port: number; captured: { current?: CapturedRequest }; close: () => void }> {
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
        res.writeHead(status, { 'content-type': 'application/json' });
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

  it('never sends the home directory as a workspace, because its basename is the username', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      // Starting a session in $HOME is ordinary, and `/Users/<user>` or
      // `/home/<user>` basenames to the OS USERNAME - so this fired on real
      // sessions at the DEFAULT tier while the header promised "the repo name".
      await runHook(HOOK_ENV(port), {
        hook_event_name: 'Stop',
        session_id: 'sess-123',
        cwd: homedir(),
      });

      const body = captured.current!.body;
      const payload = (body.machine as { payload: Record<string, unknown> }).payload;
      expect(payload.workspace).toBeUndefined();
      // And the username must not have reached the human line either.
      expect(JSON.stringify(body)).not.toContain(basename(homedir()));
    } finally {
      close();
    }
  }, 15000);

  it('still sends a real workspace basename', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      await runHook(HOOK_ENV(port), {
        hook_event_name: 'Stop',
        session_id: 'sess-123',
        cwd: '/Users/someone/parent/my-repo',
      });

      const payload = (captured.current!.body.machine as { payload: Record<string, unknown> }).payload;
      expect(payload.workspace).toBe('my-repo');
    } finally {
      close();
    }
  }, 15000);

  it('reduces an MCP tool to a bare kind, so server names stay local', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      // mcp__<server>__<tool> disclosed every configured MCP SERVER at the
      // default tier through a field documented as a closed set.
      await runHook(HOOK_ENV(port), {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-123',
        tool_name: 'mcp__acme_internal_crm__create_ticket',
      });

      const body = captured.current!.body;
      const activity = (body.machine as { payload: { activity: Record<string, unknown> } }).payload.activity;
      expect(activity.tool).toBe('mcp');
      expect(JSON.stringify(body)).not.toContain('acme_internal_crm');
      expect(JSON.stringify(body)).not.toContain('create_ticket');
    } finally {
      close();
    }
  }, 15000);

  it('drops a tool name that is not a plain identifier', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      await runHook(HOOK_ENV(port), {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-123',
        tool_name: 'Bash /Users/someone/secret-project/deploy.sh',
      });

      const body = captured.current!.body;
      const activity = (body.machine as { payload: { activity: Record<string, unknown> } }).payload.activity;
      expect(activity.tool).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('secret-project');
    } finally {
      close();
    }
  }, 15000);

  it('ignores an unrecognized notification_type instead of forwarding it', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      // The field was documented as a closed set but was forwarded unchecked, so
      // an upstream addition (or anything else) passed straight through.
      await runHook(HOOK_ENV(port), {
        hook_event_name: 'Stop',
        session_id: 'sess-123',
        notification_type: 'BAIT-unknown-classifier',
      });

      const body = captured.current!.body;
      const activity = (body.machine as { payload: { activity: Record<string, unknown> } }).payload.activity;
      // Falls back to the event-derived code for Stop.
      expect(activity.reason).toBe('turn_finished');
      expect(JSON.stringify(body)).not.toContain('BAIT-unknown-classifier');
    } finally {
      close();
    }
  }, 15000);

  it('does not treat a prototype key as a known notification_type', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      await runHook(HOOK_ENV(port), {
        hook_event_name: 'Stop',
        session_id: 'sess-123',
        notification_type: 'constructor',
      });

      const activity = (captured.current!.body.machine as { payload: { activity: Record<string, unknown> } }).payload
        .activity;
      expect(activity.reason).toBe('turn_finished');
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

  // A settable displayName is precisely what splits one session into two
  // actors, since the cc-bridge names the same session from sessionActorName
  // and ensureActor upserts on displayName. The old B4M_HEARTH_LABEL override
  // is gone; this pins that no leftover value in an operator's environment can
  // resurrect the split.
  it('ignores a stale B4M_HEARTH_LABEL in the environment', async () => {
    const { port, captured, close } = await startCaptureServer();
    try {
      await runHook({ ...HOOK_ENV(port), B4M_HEARTH_LABEL: 'phase-4 telegram' }, HOOK_INPUT);
      const body = captured.current!.body;
      const slug = (body.machine as { payload: { slug: string } }).payload.slug;
      expect(slug).toMatch(/^[a-z]+-[a-z]+$/);
      expect((body.actor as { displayName: string }).displayName).toBe(slug);
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
          ...ambientHookEnv(),
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

  describe('failure reporting', () => {
    it('exits 0 on a stdin error, silent by default', async () => {
      const { port, close } = await startCaptureServer();
      try {
        const { code, stderr } = await runHookCapturing(HOOK_ENV(port), { injectStdinError: true });
        expect(code).toBe(0);
        expect(stderr).toBe('');
      } finally {
        close();
      }
    }, 15000);

    it('reports a stdin error once under B4M_HEARTH_DEBUG and still exits 0', async () => {
      const { port, close } = await startCaptureServer();
      try {
        const { code, stderr } = await runHookCapturing(
          { ...HOOK_ENV(port), B4M_HEARTH_DEBUG: '1' },
          { injectStdinError: true }
        );
        expect(code).toBe(0);
        expect(stderr.trim().split('\n')).toEqual(['hearth-hook: stdin error: EIO']);
      } finally {
        close();
      }
    }, 15000);

    it('writes exactly one stderr line for a 401 under B4M_HEARTH_DEBUG, without the key', async () => {
      const { port, close } = await startCaptureServer(401);
      try {
        const { code, stderr } = await runHookCapturing({ ...HOOK_ENV(port), B4M_HEARTH_DEBUG: '1' });
        expect(code).toBe(0);
        expect(stderr.trim().split('\n')).toHaveLength(1);
        expect(stderr).toContain('401');
        expect(stderr).not.toContain('test-key');
      } finally {
        close();
      }
    }, 15000);

    it('stays silent on a non-2xx without the debug flag', async () => {
      const { port, close } = await startCaptureServer(429);
      try {
        const { code, stderr } = await runHookCapturing(HOOK_ENV(port));
        expect(code).toBe(0);
        expect(stderr).toBe('');
      } finally {
        close();
      }
    }, 15000);

    it('stays silent on a non-2xx with B4M_HEARTH_DEBUG=0', async () => {
      const { port, close } = await startCaptureServer(401);
      try {
        const { code, stderr } = await runHookCapturing({ ...HOOK_ENV(port), B4M_HEARTH_DEBUG: '0' });
        expect(code).toBe(0);
        expect(stderr).toBe('');
      } finally {
        close();
      }
    }, 15000);

    it('stays silent on a 2xx even with the debug flag', async () => {
      const { port, close } = await startCaptureServer(201);
      try {
        const { code, stderr, stdout } = await runHookCapturing({ ...HOOK_ENV(port), B4M_HEARTH_DEBUG: '1' });
        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(stdout).toBe('');
      } finally {
        close();
      }
    }, 15000);

    // Port 1 needs no listener of ours and is never in use, so fetch rejects instead of answering.
    it('reports a thrown fetch error once under B4M_HEARTH_DEBUG and still exits 0', async () => {
      const { code, stderr } = await runHookCapturing({ ...HOOK_ENV(1), B4M_HEARTH_DEBUG: '1' });
      expect(code).toBe(0);
      expect(stderr.trim().split('\n')).toEqual([
        expect.stringMatching(/^hearth-hook: POST \/api\/hearth\/events error: \w+$/),
      ]);
    }, 15000);

    it.each([
      ['ECONNREFUSED', 'ECONNREFUSED'],
      [42, 'TypeError'],
    ])('reports only a string fetch cause code (%s)', async (causeCode, diagnostic) => {
      const { code, stderr } = await runHookCapturing(
        { ...HOOK_ENV(1), B4M_HEARTH_DEBUG: '1' },
        {
          preloads: [
            `globalThis.fetch = async () => {
              throw new TypeError('fetch failed: private endpoint', { cause: { code: ${JSON.stringify(causeCode)} } });
            };`,
          ],
        }
      );
      expect(code).toBe(0);
      expect(stderr).toBe(`hearth-hook: POST /api/hearth/events error: ${diagnostic}\n`);
    });

    it('identifies malformed stdin as a payload failure and still exits 0', async () => {
      const { code, stderr } = await runHookCapturing(
        { ...HOOK_ENV(1), B4M_HEARTH_DEBUG: '1' },
        { stdinPayload: 'this is not json{{{' }
      );
      expect(code).toBe(0);
      expect(stderr).toBe('hearth-hook: stdin payload error: SyntaxError\n');
    });

    it('identifies an invalid API URL as a configuration failure and still exits 0', async () => {
      const { code, stderr } = await runHookCapturing({
        ...HOOK_ENV(1),
        B4M_API_URL: 'not a URL',
        B4M_HEARTH_DEBUG: '1',
      });
      expect(code).toBe(0);
      expect(stderr).toBe('hearth-hook: configuration error: ERR_INVALID_URL\n');
    });

    it.each(['B4M_API_URL', 'B4M_API_KEY'])('reports a missing %s under debug without sending a request', async key => {
      const { code, stderr, stdout } = await runHookCapturing(
        { ...HOOK_ENV(1), [key]: '', B4M_HEARTH_DEBUG: '1' },
        { preloads: ["globalThis.fetch = async () => { process.stdout.write('unexpected fetch'); };"] }
      );
      expect(code).toBe(0);
      expect(stderr).toBe('hearth-hook: configuration error: missing B4M_API_URL or B4M_API_KEY\n');
      expect(stdout).toBe('');
    });

    it.each(['B4M_API_URL', 'B4M_API_KEY'])('stays silent when %s is missing and debug is disabled', async key => {
      const { code, stderr, stdout } = await runHookCapturing(
        { ...HOOK_ENV(1), [key]: '', B4M_HEARTH_DEBUG: '0' },
        { preloads: ["globalThis.fetch = async () => { process.stdout.write('unexpected fetch'); };"] }
      );
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toBe('');
    });

    it('waits for the stderr callback before exiting', async () => {
      const { code, stdout } = await runHookCapturing(
        { ...HOOK_ENV(1), B4M_HEARTH_DEBUG: '1' },
        {
          preloads: [
            `setInterval(() => {}, 1000);
            let flushed = false;
            process.stderr.write = (_line, callback) => {
              setTimeout(() => { flushed = true; callback(); }, 50);
              return true;
            };
            globalThis.fetch = async () => ({ ok: false, status: 401 });
            process.on('exit', () => process.stdout.write(flushed ? 'flushed' : 'dropped'));`,
          ],
        }
      );
      expect(code).toBe(0);
      expect(stdout).toBe('flushed');
    });

    // Record configured budgets instead of racing CI scheduling against wall time.
    it.each([false, true])('reserves diagnostic flush time inside the request budget (stalled=%s)', async stalled => {
      const { code, stderr, stdout } = await runHookCapturing(
        { ...HOOK_ENV(1), B4M_HEARTH_DEBUG: '1' },
        {
          preloads: [
            String.raw`const originalSetTimeout = globalThis.setTimeout;
            setInterval(() => {}, 1000);
            AbortSignal.timeout = milliseconds => {
              process.stdout.write('request:' + milliseconds + '\n');
              const controller = new AbortController();
              originalSetTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), milliseconds / 10);
              return controller.signal;
            };
            globalThis.setTimeout = (callback, milliseconds, ...args) => {
              process.stdout.write('flush:' + milliseconds + '\n');
              return originalSetTimeout(callback, milliseconds / 10, ...args);
            };
            globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
            ${stalled ? 'process.stderr.write = () => false;' : ''}`,
          ],
        }
      );
      expect(code).toBe(0);
      expect(stdout.trim().split('\n')).toEqual(['request:2750', 'flush:250']);
      expect(stderr).toBe(stalled ? '' : 'hearth-hook: POST /api/hearth/events error: TimeoutError\n');
    });

    it.each(['', '0'])('keeps the full request budget when debug is disabled (%s)', async debugFlag => {
      const { code, stderr, stdout } = await runHookCapturing(
        { ...HOOK_ENV(1), B4M_HEARTH_DEBUG: debugFlag },
        {
          preloads: [
            `AbortSignal.timeout = milliseconds => {
              process.stdout.write('request:' + milliseconds);
              return new AbortController().signal;
            };
            globalThis.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };`,
          ],
        }
      );
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toBe('request:3000');
    });

    it('stays silent on a thrown fetch error without the debug flag', async () => {
      const { code, stderr } = await runHookCapturing(HOOK_ENV(1));
      expect(code).toBe(0);
      expect(stderr).toBe('');
    }, 15000);

    it('exits 0 when a debug line is written to a closed stderr', async () => {
      const { port, close } = await startCaptureServer(401);
      try {
        const { code } = await runHookCapturing({ ...HOOK_ENV(port), B4M_HEARTH_DEBUG: '1' }, { closedStderr: true });
        expect(code).toBe(0);
      } finally {
        close();
      }
    }, 15000);

    // The flush is awaited so the line survives, but it must never be the exit's
    // slowest input: a full pipe with nobody reading would otherwise hold the
    // session open for as long as the reader stays away.
    it('exits promptly when the debug line cannot be flushed to a stalled stderr', async () => {
      const { port, close } = await startCaptureServer(401);
      try {
        const started = Date.now();
        const { code } = await runHookCapturing({ ...HOOK_ENV(port), B4M_HEARTH_DEBUG: '1' }, { stalledStderr: true });
        expect(code).toBe(0);
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        close();
      }
    }, 15000);

    it('exits promptly on a stdin error when stderr is stalled', async () => {
      const { port, close } = await startCaptureServer(201);
      try {
        const started = Date.now();
        const { code } = await runHookCapturing(
          { ...HOOK_ENV(port), B4M_HEARTH_DEBUG: '1' },
          { injectStdinError: true, stalledStderr: true }
        );
        expect(code).toBe(0);
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        close();
      }
    }, 15000);
  });
});
