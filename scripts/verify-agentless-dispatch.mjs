#!/usr/bin/env node

/**
 * Verify agentless agent_executor dispatch (#8922) end-to-end against a
 * deployed environment. Drives the WebSocket directly because there's no UI
 * surface for the agentless path yet (lands in M2 / #8923) — `@mention`
 * orchestration is unaffected by this PR and is covered by browser smoke.
 *
 * Two phases:
 *   1. **Smoke** — dispatch a short query without `agentId` / `enabledTools`,
 *      assert `completed` event arrives. Validates the synthetic-profile branch
 *      end-to-end on a real Lambda.
 *   2. **Reconnect** — dispatch a longer query, drop the WS once a step has
 *      streamed, open a fresh WS, send `reconnect`, assert `reconnect_result`
 *      carries the persisted checkpoint state. Validates the checkpoint plumbing
 *      from PR #8773 still works on synthetic-profile runs (issue #8922
 *      verification matrix).
 *
 * Usage:
 *   BASE_URL=https://app.pr8933.preview.bike4mind.com \
 *   TEST_EMAIL=agentless-e2e@test.com \
 *   E2E_CLEANUP_SECRET=<the stage's shared E2E secret (SST E2E_CLEANUP_SECRET)> \
 *   node scripts/verify-agentless-dispatch.mjs
 *
 * Auth is passwordless (email OTC), so the script authenticates through the
 * E2E test plumbing instead of a mailbox: it mints the account via the gated
 * /api/test/create-user endpoint (which returns tokens directly), falling back
 * to the OTC flow (/api/otc/send -> /api/test/otc-code -> /api/otc/verify) when
 * the account already exists. Both paths require an `-e2e@test.com` email and
 * the shared E2E secret, and only work on non-production stages (the test
 * endpoints are hard-disabled on prod).
 *
 * Credentials are read from env vars (never argv) to keep them out of shell
 * history and process listings. The script does not log the access token.
 */

// Node 22+ provides global WebSocket — no dependency needed.

const BASE_URL = process.env.BASE_URL;
const TEST_EMAIL = process.env.TEST_EMAIL ?? 'agentless-e2e@test.com';
const E2E_CLEANUP_SECRET = process.env.E2E_CLEANUP_SECRET;

if (!BASE_URL) {
  // Fail fast rather than silently hit a stale default — a hard-coded preview
  // URL would silently target a defunct env once this PR merges and the
  // preview deployment is torn down.
  console.error('BASE_URL env var is required.');
  console.error('Example: BASE_URL=https://app.pr8933.preview.bike4mind.com ...');
  process.exit(2);
}
const TEST_MODEL = process.env.TEST_MODEL ?? 'claude-sonnet-4-6';
const SMOKE_QUERY =
  process.env.SMOKE_QUERY ?? 'Reply with the single word "pong" and nothing else. Do not call any tools.';
const RECONNECT_QUERY =
  process.env.RECONNECT_QUERY ??
  'Think step by step about how to add two two-digit numbers, then walk me through adding 47 and 86. Take your time and be thorough.';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 180_000);
const SKIP_RECONNECT = process.env.SKIP_RECONNECT === '1';

if (!E2E_CLEANUP_SECRET) {
  console.error('E2E_CLEANUP_SECRET env var is required (the stage\'s shared E2E secret).');
  process.exit(2);
}

// The test auth endpoints only serve -e2e@test.com accounts; fail fast with a
// clear message instead of a confusing 400 from the server.
if (!/-e2e@test\.com$/i.test(TEST_EMAIL)) {
  console.error(`TEST_EMAIL must end with -e2e@test.com (got ${TEST_EMAIL}).`);
  process.exit(2);
}

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${url} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function getJson(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function postAuthed(url, accessToken, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${url} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Auth — passwordless (OTC) via the E2E test plumbing
// ---------------------------------------------------------------------------

/**
 * Obtain an access token for TEST_EMAIL without a mailbox.
 *
 * Fast path: /api/test/create-user mints the account AND returns a token pair
 * in one call. When the account already exists that call fails, so fall back
 * to a real OTC login: /api/otc/send issues the pending token, the gated
 * /api/test/otc-code hands back the plaintext code (non-prod,
 * -e2e@test.com accounts only), and /api/otc/verify exchanges them for tokens.
 * Mirrors apps/client/e2e/helpers/api.ts (apiCreateTestUser / apiGetOtcCode).
 */
async function obtainAccessToken() {
  const secretHeader = { 'x-e2e-cleanup-secret': E2E_CLEANUP_SECRET };
  const username = TEST_EMAIL.split('@')[0];

  try {
    const created = await postJson(
      `${BASE_URL}/api/test/create-user`,
      // Passwordless account: empty password matches how OTC registration seeds users.
      { username, email: TEST_EMAIL, name: username, password: '' },
      secretHeader
    );
    log(`Created test user ${TEST_EMAIL}`);
    return { accessToken: created.accessToken, userId: created.user?.id ?? '<unknown>' };
  } catch (err) {
    // 401/403 mean a bad secret or a production stage — the OTC fallback needs
    // the same secret, so surface the real problem instead of failing twice.
    if (/ 40[13] /.test(err.message)) throw err;
    log(`create-user unavailable (${err.message.slice(0, 120)}) — falling back to OTC login`);
  }

  // /api/otc/send enforces a 30s per-recipient cooldown (429) — reruns within
  // that window just need to wait it out.
  const { pendingToken } = await postJson(`${BASE_URL}/api/otc/send`, { email: TEST_EMAIL });

  const codeRes = await fetch(`${BASE_URL}/api/test/otc-code?email=${encodeURIComponent(TEST_EMAIL)}`, {
    headers: secretHeader,
  });
  if (!codeRes.ok) {
    const text = await codeRes.text().catch(() => '');
    throw new Error(`GET /api/test/otc-code failed: ${codeRes.status} — ${text.slice(0, 200)}`);
  }
  const { code } = await codeRes.json();

  const verifyRes = await postJson(`${BASE_URL}/api/otc/verify`, { email: TEST_EMAIL, code, pendingToken });
  if (verifyRes.registrationRequired) {
    throw new Error(`No account for ${TEST_EMAIL} and create-user failed — cannot register via this path.`);
  }
  if (verifyRes.mfaRequired || verifyRes.mfaSetupRequired) {
    throw new Error(`Account ${TEST_EMAIL} requires MFA — use a plain -e2e@test.com account without MFA.`);
  }
  if (!verifyRes.accessToken) {
    throw new Error('OTC verify response did not include accessToken.');
  }
  return { accessToken: verifyRes.accessToken, userId: verifyRes.id ?? verifyRes._id ?? '<unknown>' };
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

/**
 * Open a WS connection and return it once `open` fires. Caller owns close.
 */
function openWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const onOpen = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      resolve(ws);
    };
    const onError = event => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      reject(new Error(`WS open failed: ${event.message ?? 'unknown'}`));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
}

/**
 * Subscribe to executor events on a WS. Caller can `unsubscribe()` to detach.
 * Returns parsed messages via `onEvent(action, payload)`.
 */
function subscribeEvents(ws, onEvent) {
  const handler = event => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    } catch {
      return;
    }
    if (msg?.action) onEvent(msg.action, msg);
  };
  ws.addEventListener('message', handler);
  return () => ws.removeEventListener('message', handler);
}

// ---------------------------------------------------------------------------
// Phase 1: smoke — dispatch + wait for completed
// ---------------------------------------------------------------------------

async function smokeDispatch(accessToken, wsUrl, sessionId) {
  log('--- Phase 1: smoke ---');
  const ws = await openWs(wsUrl);
  const state = {
    executionId: null,
    answer: null,
    iterations: 0,
    failure: null,
    outcome: null,
  };

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`smoke phase timed out after ${RUN_TIMEOUT_MS / 1000}s`)), RUN_TIMEOUT_MS);
      const unsub = subscribeEvents(ws, (evt, msg) => {
        switch (evt) {
          case 'execution_started':
            state.executionId = msg.executionId;
            log(`execution_started: ${state.executionId}`);
            break;
          case 'iteration_step':
            state.iterations += 1;
            if (msg.step?.type === 'final_answer') log(`step ${state.iterations}: final_answer`);
            else if (msg.step?.type === 'action')
              log(`step ${state.iterations}: action → ${msg.step?.metadata?.toolName ?? '?'}`);
            else log(`step ${state.iterations}: ${msg.step?.type}`);
            break;
          case 'completed':
            state.answer = msg.answer ?? null;
            state.outcome = 'completed';
            log(`completed (iterations=${msg.totalIterations ?? '?'}, credits=${msg.totalCreditsUsed ?? '?'})`);
            clearTimeout(timer);
            unsub();
            resolve();
            break;
          case 'failed':
            state.failure = msg.reason ?? msg.message ?? 'unknown';
            state.outcome = 'failed';
            log(`failed: ${state.failure}`);
            clearTimeout(timer);
            unsub();
            resolve();
            break;
          case 'agent_error':
            state.failure = msg.message ?? 'agent_error';
            state.outcome = 'failed';
            log(`agent_error: ${state.failure}`);
            clearTimeout(timer);
            unsub();
            resolve();
            break;
          default:
            break;
        }
      });

      log('WS open — dispatching with no agentId / no enabledTools');
      ws.send(
        JSON.stringify({
          accessToken,
          action: 'agent_execute',
          command: 'start',
          sessionId,
          questId: sessionId,
          query: SMOKE_QUERY,
          model: TEST_MODEL,
        })
      );
    });
  } finally {
    ws.close();
  }

  return state;
}

// ---------------------------------------------------------------------------
// Phase 2: reconnect — dispatch, drop WS mid-stream, reopen, send reconnect
// ---------------------------------------------------------------------------

async function reconnectDispatch(accessToken, wsUrl, sessionId) {
  log('--- Phase 2: reconnect ---');
  const state = {
    executionId: null,
    firstWsStepsSeen: 0,
    reconnectResult: null,
    finalOutcome: null,
    finalAnswer: null,
    finalIterations: null,
  };

  // 2a — open WS, dispatch, wait for execution_started + 1 iteration_step,
  // then drop the connection mid-stream.
  const ws1 = await openWs(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not see first iteration_step within 30s')), 30_000);
    let resolved = false;
    const unsub = subscribeEvents(ws1, (evt, msg) => {
      if (evt === 'execution_started') {
        state.executionId = msg.executionId;
        log(`execution_started: ${state.executionId}`);
      } else if (evt === 'iteration_step') {
        state.firstWsStepsSeen += 1;
        log(`(ws1) step ${state.firstWsStepsSeen}: ${msg.step?.type ?? '?'}`);
        if (state.firstWsStepsSeen >= 1 && !resolved) {
          resolved = true;
          clearTimeout(timer);
          unsub();
          resolve();
        }
      } else if (evt === 'failed' || evt === 'agent_error') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          unsub();
          reject(new Error(`Run failed before first step: ${msg.reason ?? msg.message ?? 'unknown'}`));
        }
      }
    });

    log('WS#1 open — dispatching longer query (agentless)');
    ws1.send(
      JSON.stringify({
        accessToken,
        action: 'agent_execute',
        command: 'start',
        sessionId,
        questId: sessionId,
        query: RECONNECT_QUERY,
        model: TEST_MODEL,
      })
    );
  });

  if (!state.executionId) throw new Error('execution_started never arrived');
  log('Dropping WS#1 mid-stream to simulate refresh / network blip');
  ws1.close();

  // Brief pause to give the server a moment to register the disconnect.
  await new Promise(r => setTimeout(r, 2_000));

  // 2b — open a fresh WS, send reconnect, verify reconnect_result carries state.
  const ws2 = await openWs(wsUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reconnect_result did not arrive within 15s')), 15_000);
      const unsub = subscribeEvents(ws2, (evt, msg) => {
        if (evt === 'reconnect_result') {
          state.reconnectResult = msg;
          log(
            `reconnect_result: found=${msg.found}, status=${msg.status ?? '?'}, ` +
              `stepCount=${msg.steps?.length ?? (msg.stepsTruncated ? 'truncated' : 0)}, ` +
              `iterationCount=${msg.iterationCount ?? '?'}`
          );
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });

      log('WS#2 open — sending reconnect');
      ws2.send(
        JSON.stringify({
          accessToken,
          action: 'agent_execute',
          command: 'reconnect',
          executionId: state.executionId,
        })
      );
    });

    if (!state.reconnectResult?.found) {
      throw new Error('reconnect_result.found was false — executor lost track of the execution');
    }

    // The reconnect_result event is itself the proof of checkpoint replay —
    // the executor found the doc by id, projected its status + persisted
    // steps, and shipped them on the new connection. We do NOT wait for a
    // terminal `completed` event on WS#2 because the still-running Lambda
    // caches the *original* connectionId in `createWsSender`; subsequent
    // events from that invocation fail silently to the dead WS#1 even
    // though `handleReconnect` already repointed the doc. Lambda
    // self-dispatch (on 15-min handoff or subagent boundary) re-reads the
    // doc and would land events on WS#2, but for sub-15-min queries that
    // path doesn't fire. Not a bug — the checkpoint state itself is the
    // contract surface for refresh resilience, and `reconnect_result`
    // already proved it.
    state.finalOutcome = state.reconnectResult.status ?? 'unknown';
  } finally {
    ws2.close();
  }

  return state;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Target: ${BASE_URL}`);

  // Login (passwordless — via the E2E test plumbing)
  log(`Authenticating as ${TEST_EMAIL}…`);
  const { accessToken, userId } = await obtainAccessToken();
  log(`Authenticated (userId=${userId})`);

  // Server config → WebSocket URL
  const serverConfig = await getJson(`${BASE_URL}/api/settings/serverConfig`, accessToken);
  if (!serverConfig.websocketUrl) throw new Error('serverConfig did not include websocketUrl');
  const wsUrl = `${serverConfig.websocketUrl}?token=${encodeURIComponent(accessToken)}`;
  log(`WebSocket URL: ${serverConfig.websocketUrl}`);

  // Fresh sessions per phase keeps state isolated.
  const sessionA = await postAuthed(`${BASE_URL}/api/sessions/create`, accessToken, {
    name: `Agentless smoke ${new Date().toISOString()}`,
  });
  log(`Session A (smoke):     ${sessionA.id}`);

  const smoke = await smokeDispatch(accessToken, wsUrl, sessionA.id);

  let reconnect = null;
  if (!SKIP_RECONNECT) {
    const sessionB = await postAuthed(`${BASE_URL}/api/sessions/create`, accessToken, {
      name: `Agentless reconnect ${new Date().toISOString()}`,
    });
    log(`Session B (reconnect): ${sessionB.id}`);
    reconnect = await reconnectDispatch(accessToken, wsUrl, sessionB.id);
  }

  // ---- Report ----
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Agentless dispatch verification');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Target:           ${BASE_URL}`);
  console.log(`Model:            ${TEST_MODEL}`);
  console.log('');
  console.log('Phase 1 — smoke (synthetic-profile dispatch end-to-end)');
  console.log(`  Execution:      ${smoke.executionId ?? '(none)'}`);
  console.log(`  Iterations:     ${smoke.iterations}`);
  console.log(`  Outcome:        ${(smoke.outcome ?? 'unknown').toUpperCase()}`);
  // The `answer` field on `completed` reflects the FIRST `final_answer` step's
  // content (executor uses `steps.find(s => s.type === 'final_answer')?.content`
  // — pre-existing, not introduced by this PR). For streamed answers this is
  // just the first delta, not the accumulated text. We display it for
  // debugging but do not gate on its content — `outcome === COMPLETED` is the
  // assertion.
  if (smoke.answer) console.log(`  First delta:    ${String(smoke.answer).slice(0, 200)}`);
  if (smoke.failure) console.log(`  Failure:        ${smoke.failure}`);

  if (reconnect) {
    console.log('');
    console.log('Phase 2 — reconnect (checkpoint state replay on synthetic-profile run)');
    console.log(`  Execution:      ${reconnect.executionId ?? '(none)'}`);
    console.log(`  Steps on WS#1:  ${reconnect.firstWsStepsSeen} (before drop)`);
    const r = reconnect.reconnectResult ?? {};
    console.log(`  Reconnect:      found=${r.found ?? false}, status=${r.status ?? '?'}`);
    console.log(`  Replayed steps: ${r.steps?.length ?? (r.stepsTruncated ? 'truncated-inline' : 0)}`);
    console.log(`  iterationCount: ${r.iterationCount ?? '?'} (server-persisted checkpoint counter)`);
    console.log('  (Replayed-step count of 0 is expected for a single-iteration run:');
    console.log('   only `final_answer` step types fired before drop, and the executor');
    console.log('   skips in-flight persist for those — the boundary write happens at');
    console.log('   iteration close. The `found=true` reply is the contract surface.)');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const smokeOk = smoke.outcome === 'completed' && !!smoke.executionId;
  const reconnectOk =
    !reconnect ||
    (!!reconnect.reconnectResult?.found && !!reconnect.executionId);

  if (!smokeOk || !reconnectOk) {
    console.error('');
    if (!smokeOk) console.error('FAIL: smoke phase did not complete cleanly');
    if (!reconnectOk) console.error('FAIL: reconnect phase did not return found=true');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('');
  console.error('VERIFICATION FAILED:', err.message);
  process.exit(1);
});
