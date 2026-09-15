#!/usr/bin/env tsx
/**
 * End-to-end WebSocket integration tester for the `agent_execute` route.
 *
 * Covers subagent execution and the concurrent-execution cap; reusable for any
 * future change that touches the agent_execute flow.
 *
 * Tests:
 *   - basic           start -> execution_started -> iteration_step -> completed
 *   - delegate        parent fires delegate_to_agent -> subagent_* events with matching childExecutionId
 *   - concurrent-cap  3 parents kept alive via subagent work -> 4th rejected with concurrent_limit
 *
 * Usage:
 *   pnpm --filter @bike4mind/scripts test:agent-execute-ws \
 *     -- --base-url=https://app.pr<N>.preview.bike4mind.com [test]
 *
 *   # all three (default):
 *   pnpm --filter @bike4mind/scripts test:agent-execute-ws -- --base-url=...
 *
 *   # single test:
 *   pnpm --filter @bike4mind/scripts test:agent-execute-ws -- --base-url=... basic
 *
 * Auth: the app is passwordless (OTC), so this mints a throwaway test user via
 * the /api/test/create-user endpoint - set E2E_CLEANUP_SECRET for the target env.
 *
 * Or via env + tsx directly (from packages/scripts/):
 *   BASE_URL=... E2E_CLEANUP_SECRET=... tsx testAgentExecuteWs.ts basic
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type CliArgs = {
  baseUrl: string;
  email: string;
  password: string;
  model: string;
  delegateQuery: string;
  timeoutMs: number;
  quiet: boolean;
  test: 'basic' | 'delegate' | 'concurrent-cap' | 'all';
  wsUrl?: string;
};

function parseArgs(): CliArgs {
  const flagPattern = /^--([\w-]+)(?:=(.*))?$/;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(flagPattern);
    if (m) flags[m[1]] = m[2] ?? 'true';
    else positional.push(arg);
  }
  const test = (positional[0] ?? 'all') as CliArgs['test'];
  if (!['basic', 'delegate', 'concurrent-cap', 'all'].includes(test)) {
    throw new Error(`Unknown test: ${test}. Use one of: basic, delegate, concurrent-cap, all`);
  }
  const baseUrl = (flags['base-url'] ?? process.env.BASE_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('--base-url=<url> or BASE_URL env is required');
  return {
    baseUrl,
    email: flags.email ?? process.env.EMAIL ?? 'test@test.com',
    password: flags.password ?? process.env.PASSWORD ?? 'Testing12345!',
    model: flags.model ?? process.env.MODEL ?? 'gpt-5',
    delegateQuery:
      flags['delegate-query'] ??
      process.env.DELEGATE_QUERY ??
      // Asks for FIVE facts with sources to push the subagent to ~10-15s of work.
      // The parent stays in `running` status for the whole subagent runtime, which
      // widens the concurrent-cap test's race-free window.
      'Use the delegate_to_agent tool to ask the Researcher subagent for FIVE distinct verifiable bicycle facts, each with a source URL. Then synthesise them into one short paragraph.',
    timeoutMs: Number(flags.timeout ?? process.env.TIMEOUT_MS ?? 120_000),
    quiet: flags.quiet === 'true' || process.env.QUIET === '1',
    wsUrl: flags['ws-url'] ?? process.env.WS_URL,
    test,
  };
}

// ---------------------------------------------------------------------------
// HTTP types & helpers
// ---------------------------------------------------------------------------

type HttpInit = RequestInit & { token?: string };

async function httpJson<T>(baseUrl: string, path: string, init: HttpInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

type CreateUserResponse = {
  accessToken?: string;
  refreshToken?: string;
  user?: { id?: string; _id?: string };
};

/**
 * Mints an authenticated session for the test run.
 *
 * Password login was removed (the app is passwordless/OTC), and OTC can't be
 * driven headlessly (no inbox to read the code), so this uses the test-only
 * token-mint endpoint /api/test/create-user - the same machine path the E2E
 * suite uses. Requires E2E_CLEANUP_SECRET for the target environment.
 */
async function login(args: CliArgs): Promise<{ token: string; userId: string }> {
  const secret = process.env.E2E_CLEANUP_SECRET;
  if (!secret) {
    throw new Error('E2E_CLEANUP_SECRET env is required to mint a test-user token (password login has been removed).');
  }
  // A fresh, uniquely-named user per run avoids collisions on repeated runs.
  const stamp = `${Date.now().toString(36)}-${process.pid}`;
  const username = `agent-ws-${stamp}`;
  const email = `${username}-e2e@test.com`;
  const body = await httpJson<CreateUserResponse>(args.baseUrl, '/api/test/create-user', {
    method: 'POST',
    headers: { 'x-e2e-cleanup-secret': secret },
    body: JSON.stringify({ username, email, name: username, password: args.password, isAdmin: false }),
  });
  if (!body.accessToken) throw new Error(`create-user response missing accessToken`);
  const userId = body.user?.id ?? body.user?._id;
  if (!userId) throw new Error(`create-user response missing user id`);
  return { token: body.accessToken, userId };
}

async function resolveWsUrl(args: CliArgs, token: string): Promise<string> {
  if (args.wsUrl) return args.wsUrl;
  const cfg = await httpJson<{ websocketUrl?: string }>(args.baseUrl, '/api/settings/serverConfig', { token });
  if (!cfg.websocketUrl) throw new Error('serverConfig response missing websocketUrl');
  return cfg.websocketUrl;
}

async function createSession(args: CliArgs, token: string, name?: string): Promise<string> {
  const body = await httpJson<{ id?: string; _id?: string }>(args.baseUrl, '/api/sessions/create', {
    method: 'POST',
    body: JSON.stringify({ name: name ?? `agent-execute-test ${new Date().toISOString()}` }),
    token,
  });
  const id = body.id ?? body._id;
  if (!id) throw new Error('session create response missing id');
  return id;
}

async function createQuest(args: CliArgs, token: string, sessionId: string, prompt: string): Promise<string> {
  const body = await httpJson<{ id?: string; _id?: string }>(args.baseUrl, `/api/sessions/${sessionId}/chat`, {
    method: 'POST',
    body: JSON.stringify({ type: 'message', prompt, timestamp: new Date().toISOString() }),
    token,
  });
  const id = body.id ?? body._id;
  if (!id) throw new Error('quest create response missing id');
  return id;
}

// ---------------------------------------------------------------------------
// WS protocol types
// ---------------------------------------------------------------------------

// Mirrors the schemas in apps/client/server/websocket/agentExecute.ts.
// Kept as a local type rather than imported because `apps/*` is not a workspace
// dep of `packages/scripts/*` - apps depend on packages, not the other way around.

type StartCommand = {
  action: 'agent_execute';
  command: 'start';
  accessToken: string;
  sessionId: string;
  questId: string;
  query: string;
  model: string;
  organizationId?: string;
  enabledTools?: string[];
  maxIterations?: number;
};

type AbortCommand = {
  action: 'agent_execute';
  command: 'abort';
  accessToken: string;
  executionId: string;
};

// Server emits action-tagged JSON events. A single permissive type keeps the
// access pattern simple - explicit field reads at use-sites where the test logic
// already knows the action it's branched on.
type ServerEvent = {
  action: string;
  executionId?: string;
  childExecutionId?: string;
  agentName?: string;
  model?: string;
  thoroughness?: string;
  maxIterations?: number;
  iteration?: number;
  step?: unknown;
  reason?: string;
  message?: string;
  totalCredits?: number;
  totalCreditsUsed?: number;
  totalIterations?: number;
  iterations?: number;
  isComplete?: boolean;
  toolName?: string;
  error?: string;
  isTimeout?: boolean;
  [k: string]: unknown;
};

type Predicate = (e: ServerEvent) => boolean;

type Socket = {
  ws: WebSocket;
  events: ServerEvent[];
  waitFor: <T extends ServerEvent = ServerEvent>(p: Predicate, label: string, timeoutMs?: number) => Promise<T>;
  close: () => void;
};

function summarize(payload: ServerEvent): string {
  const { action, ...rest } = payload as Record<string, unknown>;
  const trimmed: Record<string, unknown> = {};
  for (const k of Object.keys(rest).slice(0, 6)) {
    const v = rest[k];
    trimmed[k] = typeof v === 'string' && v.length > 80 ? `${v.slice(0, 77)}…` : v;
  }
  return `${action ?? '<no-action>'} ${Object.keys(trimmed).length ? JSON.stringify(trimmed) : ''}`;
}

function openSocket(wsUrl: string, label: string, args: CliArgs): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const events: ServerEvent[] = [];
    type Waiter = {
      predicate: Predicate;
      label: string;
      resolve: (e: ServerEvent) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    };
    const waiters = new Set<Waiter>();

    ws.addEventListener('message', (evt: MessageEvent) => {
      let payload: ServerEvent;
      try {
        payload = JSON.parse(String(evt.data)) as ServerEvent;
      } catch {
        payload = { action: 'raw', raw: String(evt.data) } as ServerEvent;
      }
      events.push(payload);
      if (!args.quiet) console.log(`[${label}] ←`, summarize(payload));
      for (const w of [...waiters]) {
        if (w.predicate(payload)) {
          waiters.delete(w);
          clearTimeout(w.timer);
          w.resolve(payload);
        }
      }
    });
    ws.addEventListener('error', (err: Event) =>
      console.error(`[${label}] ws error`, (err as ErrorEvent).message ?? err)
    );
    ws.addEventListener('close', (evt: CloseEvent) => {
      if (!args.quiet) console.log(`[${label}] closed code=${evt.code}`);
      for (const w of [...waiters]) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.reject(new Error(`[${label}] ws closed before "${w.label}" arrived`));
      }
    });
    ws.addEventListener('open', () => {
      if (!args.quiet) console.log(`[${label}] open`);
      resolve({
        ws,
        events,
        waitFor: <T extends ServerEvent = ServerEvent>(
          p: Predicate,
          lbl: string,
          timeoutMs = args.timeoutMs
        ): Promise<T> => {
          const found = events.find(p);
          if (found) return Promise.resolve(found as T);
          return new Promise<T>((res, rej) => {
            const w: Waiter = {
              predicate: p,
              label: lbl,
              resolve: e => res(e as T),
              reject: rej,
              timer: setTimeout(() => {
                waiters.delete(w);
                rej(new Error(`[${lbl}] timed out after ${timeoutMs}ms`));
              }, timeoutMs),
            };
            waiters.add(w);
          });
        },
        close: () => ws.close(),
      });
    });
    setTimeout(() => reject(new Error(`[${label}] open timeout`)), 10_000);
  });
}

function send(ws: WebSocket, payload: StartCommand | AbortCommand): void {
  ws.send(JSON.stringify(payload));
}

function startMsg(token: string, sessionId: string, questId: string, query: string, model: string): StartCommand {
  return { action: 'agent_execute', command: 'start', accessToken: token, sessionId, questId, query, model };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

type Ctx = { args: CliArgs; token: string; wsUrl: string };

async function testBasic(ctx: Ctx): Promise<void> {
  console.log('\n=== basic: start → execution_started → iteration_step → completed ===');
  const sessionId = await createSession(ctx.args, ctx.token);
  const questId = await createQuest(ctx.args, ctx.token, sessionId, 'hello');
  const sock = await openSocket(ctx.wsUrl, 'basic', ctx.args);
  send(sock.ws, startMsg(ctx.token, sessionId, questId, 'Reply with one short greeting.', ctx.args.model));

  await sock.waitFor(p => p.action === 'execution_started', 'execution_started');
  await sock.waitFor(p => p.action === 'iteration_step', 'iteration_step');
  const terminal = await sock.waitFor(
    p => p.action === 'completed' || p.action === 'agent_error',
    'completed|agent_error'
  );
  sock.close();
  assert.equal(terminal.action, 'completed', `expected completed, got ${terminal.action}`);
}

async function testDelegate(ctx: Ctx): Promise<void> {
  console.log('\n=== delegate: parent fires delegate_to_agent → subagent_* events ===');
  const sessionId = await createSession(ctx.args, ctx.token);
  const questId = await createQuest(ctx.args, ctx.token, sessionId, ctx.args.delegateQuery);
  const sock = await openSocket(ctx.wsUrl, 'delegate', ctx.args);
  send(sock.ws, startMsg(ctx.token, sessionId, questId, ctx.args.delegateQuery, ctx.args.model));

  await sock.waitFor(p => p.action === 'execution_started', 'execution_started');

  // Race subagent_started against terminal so a non-delegating parent doesn't hang.
  const subStarted = sock.waitFor(p => p.action === 'subagent_started', 'subagent_started').catch(() => null);
  const terminal = sock.waitFor(p => p.action === 'completed' || p.action === 'agent_error', 'completed|agent_error');
  const winner = await Promise.race([
    subStarted.then(p => (p ? { kind: 'sub' as const, payload: p } : null)),
    terminal.then(p => ({ kind: 'term' as const, payload: p })),
  ]);

  if (!winner || winner.kind === 'term') {
    sock.close();
    console.log('SKIP delegate — parent finished without delegating. Adjust DELEGATE_QUERY.');
    throw new SkipError('parent did not delegate');
  }

  const childId = winner.payload.childExecutionId;
  if (!childId) throw new Error('subagent_started missing childExecutionId');
  console.log('  child execution id:', childId);
  for (const field of ['agentName', 'model', 'thoroughness', 'maxIterations'] as const) {
    assert.ok(field in winner.payload, `subagent_started missing field: ${field}`);
  }

  await sock.waitFor(
    p => p.action === 'subagent_iteration_step' && p.childExecutionId === childId,
    'subagent_iteration_step (matching child id)'
  );
  const subTerm = await sock.waitFor(
    p => (p.action === 'subagent_completed' || p.action === 'subagent_failed') && p.childExecutionId === childId,
    'subagent_completed|subagent_failed'
  );
  const terminalEvent = await terminal;
  sock.close();

  assert.equal(subTerm.action, 'subagent_completed', `subagent terminated with ${subTerm.action}`);

  // Verify the credit-rollup behaviour: parent.totalCreditsUsed must include every
  // child's totalCredits via the `incrementCreditsUsed` $inc. Sum across all
  // subagent_completed events the parent emitted (a single parent run can spawn
  // multiple subagents - observed empirically).
  const completedSubagents = sock.events.filter(e => e.action === 'subagent_completed');
  const childCreditSum = completedSubagents.reduce((acc, e) => acc + (e.totalCredits ?? 0), 0);
  const parentTotal = terminalEvent.totalCreditsUsed ?? 0;
  console.log(
    `  credit rollup: ${completedSubagents.length} child(ren) totalling ${childCreditSum} credits; ` +
      `parent.totalCreditsUsed=${parentTotal}`
  );
  assert.ok(
    parentTotal >= childCreditSum,
    `credit rollup broken: parent.totalCreditsUsed=${parentTotal} < sum of children=${childCreditSum}`
  );

  console.log('  Manual follow-up (out of script scope):');
  console.log(`    db.agentExecutions.findOne({ _id: ObjectId('${childId}') })`);
  console.log('    → expect parentExecutionId set, parent.childExecutionIds contains this id');
  console.log('    → expect parent.totalCreditsUsed ≥ child.totalCreditsUsed');
}

async function testConcurrentCap(ctx: Ctx): Promise<void> {
  console.log('\n=== concurrent-cap: 3 parents kept alive via subagent work → 4th rejected ===');
  // Each parent runs delegate_to_agent -> subagent (~5-8s) -> final answer. During the
  // subagent's runtime the parent stays in `running` status (which is in the cap's
  // active set). We send all 4 sequentially within ~1-2s of each other so the 4th's
  // countActiveByUserId query reliably sees count=3 inside cap-1's lifetime window.
  //
  // Permission gating: delegate_to_agent IS in REQUIRES_APPROVAL_TOOLS
  // (toolPermissions.ts) but the agent emits the tool result as `step.type='observation'`
  // while the classifier at agentExecutor.ts:562 checks `step.type==='action'`, so the
  // halt at awaiting_permission never fires. That's a pre-existing Phase-1 mismatch.
  // We rely on the natural ~6s subagent runtime instead.
  const prompt = ctx.args.delegateQuery;

  const slots = await Promise.all(
    Array.from({ length: 4 }, async (_, i) => {
      const sessionId = await createSession(ctx.args, ctx.token);
      const questId = await createQuest(ctx.args, ctx.token, sessionId, prompt);
      const sock = await openSocket(ctx.wsUrl, `cap-${i + 1}`, ctx.args);
      return { sessionId, questId, sock };
    })
  );

  const liveExecutionIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const slot = slots[i];
    send(slot.sock.ws, startMsg(ctx.token, slot.sessionId, slot.questId, prompt, ctx.args.model));
    const started = await slot.sock.waitFor(
      p => p.action === 'execution_started',
      `cap-${i + 1} execution_started`,
      60_000
    );
    if (!started.executionId) throw new Error('execution_started missing executionId');
    liveExecutionIds.push(started.executionId);
  }

  // 4th: send immediately, expect agent_error reason=concurrent_limit.
  send(slots[3].sock.ws, startMsg(ctx.token, slots[3].sessionId, slots[3].questId, prompt, ctx.args.model));
  const fourth = await slots[3].sock.waitFor(
    p => p.action === 'agent_error' || p.action === 'execution_started',
    'cap-4 first response',
    30_000
  );
  console.log('  4th socket response:', fourth);

  // Cleanup: abort all live ones (3 stuck + possibly cap-4 if it slipped through).
  const abortAll = async (idx: number, execId: string) => {
    send(slots[idx].sock.ws, {
      action: 'agent_execute',
      command: 'abort',
      accessToken: ctx.token,
      executionId: execId,
    });
    await slots[idx].sock
      .waitFor(p => p.action === 'abort_acknowledged', `cap-${idx + 1} abort_ack`, 10_000)
      .catch(() => undefined);
  };
  await Promise.all(liveExecutionIds.map((id, i) => abortAll(i, id)));
  if (fourth.action === 'execution_started' && fourth.executionId) await abortAll(3, fourth.executionId);
  for (const slot of slots) slot.sock.close();

  assert.equal(fourth.action, 'agent_error', `expected agent_error on 4th, got ${fourth.action}`);
  assert.equal(fourth.reason, 'concurrent_limit', `expected reason=concurrent_limit, got ${fourth.reason}`);
}

class SkipError extends Error {}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const TESTS: Record<Exclude<CliArgs['test'], 'all'>, (ctx: Ctx) => Promise<void>> = {
  basic: testBasic,
  delegate: testDelegate,
  'concurrent-cap': testConcurrentCap,
};

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`BASE_URL = ${args.baseUrl}`);
  console.log(`EMAIL    = ${args.email}`);

  const { token, userId } = await login(args);
  console.log(`logged in: ${userId}`);
  const wsUrl = await resolveWsUrl(args, token);
  console.log(`WS_URL   = ${wsUrl}`);
  console.log(`MODEL    = ${args.model}`);

  const ctx: Ctx = { args, token, wsUrl };
  const toRun = args.test === 'all' ? (Object.keys(TESTS) as Array<keyof typeof TESTS>) : [args.test];

  type Result = { name: string; status: 'PASS' | 'SKIP' | 'FAIL'; error?: string };
  const results: Result[] = [];
  for (const name of toRun) {
    try {
      await TESTS[name](ctx);
      results.push({ name, status: 'PASS' });
    } catch (err) {
      if (err instanceof SkipError) results.push({ name, status: 'SKIP', error: err.message });
      else {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ name, status: 'FAIL', error: msg });
        console.error(`\nFAIL ${name}: ${msg}`);
      }
    }
  }

  console.log('\n────────── results ──────────');
  console.table(results);
  if (results.some(r => r.status === 'FAIL')) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('FATAL', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
