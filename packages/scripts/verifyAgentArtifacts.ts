#!/usr/bin/env tsx
/**
 * Live verification for server-side agent artifact persistence (PR #286).
 *
 * Exists because this change has twice passed a code read and then persisted
 * nothing on a real deploy. Both fixes it now carries live in failure/race
 * paths that a happy-path run cannot reach, so "I ran an agent and saw a card"
 * is not evidence. Each mode below asserts against the `artifacts` COLLECTION,
 * never against the rendered reply.
 *
 * Modes:
 *   happy   Run an agent that emits an <artifact>. Assert exactly one row lands,
 *           with createdFrom: 'agent' and sourceQuestId set. Guards the 07-28
 *           behaviour against regression. API only.
 *
 *   orphan  Proves the self-heal. `artifactService.create` writes
 *           artifact_contents -> artifact_versions -> artifacts untransacted, so
 *           a crash after the content write used to wedge that artifact forever
 *           (every retry hit E11000, which was swallowed as a dedup skip).
 *           The orphan state is NOT reachable through the API - `DELETE
 *           /api/artifacts/:id` only sets deletedAt on the artifacts row, and
 *           the generic findOne does not filter it, so artifactExists still
 *           reports true. So this mode starts a run, reads the dispatch-time
 *           Quest to compute the exact id the run will parse, prints the one
 *           mongosh insert that creates the orphan, waits for you to run it,
 *           then asserts the run repaired it. Needs Mongo on the target env.
 *
 * Usage:
 *   BASE_URL=https://app.pr286.preview.bike4mind.com \
 *   E2E_CLEANUP_SECRET=... \
 *     tsx packages/scripts/verifyAgentArtifacts.ts happy
 *
 * The dedup fix (a second terminal write for one quest) is deliberately NOT
 * covered here: it needs `gate_response: stop` to race a continue-resumed
 * executor, which cannot be timed reliably from outside. It is covered by unit
 * test, and that distinction is stated on the PR rather than papered over.
 */

import assert from 'node:assert/strict';
import { createInterface } from 'node:readline/promises';

const BASE_URL = process.env.BASE_URL ?? '';
const SECRET = process.env.E2E_CLEANUP_SECRET ?? '';
const MODEL = process.env.MODEL ?? 'gpt-5';
const MODE = (process.argv[2] ?? 'happy') as 'happy' | 'orphan';
const RUN_TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 180_000);

/** Identifier the prompt asks for, so the expected artifact id is predictable. */
const PROBE_IDENTIFIER = 'probe-counter';

const PROMPT =
  `Create a tiny React counter component. Return it as a single artifact and nothing else. ` +
  `The artifact tag MUST use exactly identifier="${PROBE_IDENTIFIER}" and type="application/vnd.ant.react".`;

if (!BASE_URL) throw new Error('BASE_URL is required');
if (!SECRET) throw new Error('E2E_CLEANUP_SECRET is required (mints the throwaway test user)');

const log = (...a: unknown[]) => console.log(...a);

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${body.slice(0, 400)}`);
  return body ? (JSON.parse(body) as T) : ({} as T);
}

/** Mint a throwaway user - same machine path the E2E suite uses. */
async function login(): Promise<{ token: string; userId: string }> {
  const stamp = `${Date.now().toString(36)}-${process.pid}`;
  const username = `artifact-verify-${stamp}`;
  const body = await api<{ accessToken?: string; user?: { id?: string; _id?: string } }>('/api/test/create-user', {
    method: 'POST',
    headers: { 'x-e2e-cleanup-secret': SECRET },
    body: JSON.stringify({ username, email: `${username}-e2e@test.com`, name: username, password: 'Testing12345!' }),
  });
  const token = body.accessToken;
  const userId = body.user?.id ?? body.user?._id;
  if (!token || !userId) throw new Error('create-user response missing accessToken or user id');
  log(`  user ${username} (${userId})`);
  return { token, userId };
}

async function createSession(token: string): Promise<string> {
  const s = await api<{ id: string }>('/api/sessions/create', {
    method: 'POST',
    token,
    body: JSON.stringify({ name: `artifact-verify ${new Date().toISOString()}` }),
  });
  return s.id;
}

interface ArtifactRow {
  id: string;
  sourceQuestId?: string;
  sessionId?: string;
  metadata?: { createdFrom?: string; questId?: string };
}

async function listArtifacts(token: string, sessionId: string): Promise<ArtifactRow[]> {
  const r = await api<{ artifacts?: ArtifactRow[] }>(
    `/api/artifacts?sessionId=${encodeURIComponent(sessionId)}&limit=50`,
    { token }
  );
  return r.artifacts ?? [];
}

/**
 * Poll until rows appear, because the WS `completed` event is sent BEFORE
 * `persistRunAsQuest` (and therefore `persistAgentArtifacts`) runs - see the
 * terminal block in agentExecutor.ts. Reading straight off `completed` races
 * the write and reports zero rows for a run that persists correctly a moment
 * later, which is indistinguishable from the bug this PR fixes.
 */
async function waitForArtifacts(token: string, sessionId: string, timeoutMs = 45_000): Promise<ArtifactRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: ArtifactRow[] = [];
  while (Date.now() < deadline) {
    rows = await listArtifacts(token, sessionId);
    if (rows.length > 0) return rows;
    await new Promise(r => setTimeout(r, 2_000));
  }
  return rows;
}

interface QuestRow {
  id: string;
  createdAt?: string;
  agentExecutionId?: string;
}

async function listQuests(token: string, sessionId: string): Promise<QuestRow[]> {
  const r = await api<{ quests?: QuestRow[]; data?: QuestRow[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/chat?page=1&limit=10&sort=desc`,
    { token }
  );
  return r.quests ?? r.data ?? [];
}

/**
 * Drive one agent run to a terminal event over the agent_execute WebSocket.
 * `onDispatched` fires as soon as the run is started, which is the window in
 * which the orphan mode has to seed - the dispatch-time Quest already exists by
 * then, and its createdAt is what the artifact id is built from.
 */
async function runAgent(args: {
  token: string;
  sessionId: string;
  onDispatched?: () => Promise<void>;
}): Promise<{ answer: string }> {
  const cfg = await api<{ websocketUrl?: string }>('/api/settings/serverConfig', { token: args.token });
  if (!cfg.websocketUrl) throw new Error('serverConfig response missing websocketUrl');

  return new Promise((resolve, reject) => {
    // The $connect route authenticates before the socket opens and rejects with
    // a bare 1006 otherwise. `?token=` is the web-client form; the CLI's
    // `Sec-WebSocket-Protocol: access_token.<jwt>` form is NOT usable here,
    // because the connect Lambda does not echo the accepted subprotocol back
    // and a spec-compliant client then fails the handshake.
    const wsUrl = `${cfg.websocketUrl}?token=${encodeURIComponent(args.token)}`;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`run did not reach a terminal event within ${RUN_TIMEOUT_MS}ms`));
    }, RUN_TIMEOUT_MS);
    let dispatched = false;

    const done = (fn: () => void) => {
      clearTimeout(timer);
      ws.close();
      fn();
    };

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          accessToken: args.token,
          action: 'agent_execute',
          command: 'start',
          sessionId: args.sessionId,
          questId: args.sessionId, // back-ref the client also sends
          query: PROMPT,
          model: MODEL,
        })
      );
    };

    ws.onerror = err => done(() => reject(new Error(`websocket error: ${String(err)}`)));

    ws.onmessage = async ev => {
      let msg: { action?: string; answer?: string; message?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.action === 'execution_started' && !dispatched) {
        dispatched = true;
        log('  run dispatched');
        if (args.onDispatched) {
          try {
            await args.onDispatched();
          } catch (e) {
            done(() => reject(e as Error));
          }
        }
        return;
      }
      if (msg.action === 'completed') return done(() => resolve({ answer: msg.answer ?? '' }));
      if (msg.action === 'agent_error') return done(() => reject(new Error(msg.message ?? 'agent_error')));
    };
  });
}

async function modeHappy() {
  log('\n== happy path: one agent artifact lands as one row ==');
  const { token } = await login();
  const sessionId = await createSession(token);
  log(`  session ${sessionId}`);

  assert.equal((await listArtifacts(token, sessionId)).length, 0, 'session should start with no artifacts');

  const { answer } = await runAgent({ token, sessionId });
  assert.match(answer, /<artifact/i, 'model did not emit an <artifact> block - rerun or change MODEL');

  const rows = await waitForArtifacts(token, sessionId);
  assert.equal(rows.length, 1, `expected exactly 1 artifact row, got ${rows.length}`);
  const [row] = rows;
  assert.equal(row.metadata?.createdFrom, 'agent', 'row was not written by the agent path');
  assert.ok(row.sourceQuestId, 'row is missing sourceQuestId');
  log(`  PASS  ${row.id}  sourceQuestId=${row.sourceQuestId}`);
}

async function modeOrphan() {
  log('\n== orphan repair: a partially-written artifact heals instead of wedging ==');
  const { token } = await login();
  const sessionId = await createSession(token);
  log(`  session ${sessionId}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const { answer } = await runAgent({
    token,
    sessionId,
    onDispatched: async () => {
      // The dispatch-time Quest exists now; its createdAt is what the artifact
      // id is derived from, so the expected id is computable before the run
      // terminates. That is the only window in which the orphan can be seeded.
      const quests = await listQuests(token, sessionId);
      const quest = quests.find(q => q.agentExecutionId) ?? quests[0];
      if (!quest?.createdAt) throw new Error('could not read the dispatch-time Quest to compute the artifact id');
      const ms = new Date(quest.createdAt).getTime();
      const artifactId = `artifact_react_${PROBE_IDENTIFIER}_${ms}_0`;

      log('\n  ---- run this against the target env now, then press Enter ----');
      log(
        `  db.artifact_contents.insertOne({ artifactId: ${JSON.stringify(artifactId)}, version: 1, ` +
          `content: 'orphan', contentHash: 'orphan', contentSize: 6, mimeType: 'text/plain', encoding: 'utf8', ` +
          `createdAt: new Date(), updatedAt: new Date() })`
      );
      log('  ---------------------------------------------------------------\n');
      await rl.question('  seeded? press Enter to let the run finish... ');
    },
  });

  rl.close();
  assert.match(answer, /<artifact/i, 'model did not emit an <artifact> block - rerun');

  const rows = await listArtifacts(token, sessionId);
  assert.equal(rows.length, 1, `expected the orphan to be repaired into exactly 1 row, got ${rows.length}`);
  log(`  PASS  repaired ${rows[0].id}`);
  log('  (confirm the run logged repaired: 1 - that is the self-heal firing rather than a plain create)');
}

const modes: Record<string, () => Promise<void>> = { happy: modeHappy, orphan: modeOrphan };
const run = modes[MODE];
if (!run) throw new Error(`unknown mode '${MODE}' (expected: ${Object.keys(modes).join(', ')})`);

run()
  .then(() => log('\nOK\n'))
  .catch(err => {
    console.error(`\nFAIL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
