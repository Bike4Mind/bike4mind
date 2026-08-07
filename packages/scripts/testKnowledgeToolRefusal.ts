#!/usr/bin/env tsx
/**
 * Live-model reproduction for the fresh-upload knowledge-tool refusal (issue #1163).
 *
 * Uploads a small file with a unique canary fact, attaches it to a BRAND-NEW session
 * (mirroring session.knowledgeIds, the field the auto-offer gate reads), and asks about it
 * in the same request before the file has finished chunking. Before the fix, a tool-eager
 * model (GPT-4) would call search_knowledge_base/retrieve_knowledge_content, get a
 * zero-content reply, and refuse - discarding the file's raw content that was already
 * inlined into the same prompt. Llama-on-Bedrock cannot call tools at all
 * (LlamaBedrockBackend.formatTools throws), so it is a CONTROL arm proving inline delivery
 * still works, NOT evidence the gating fix works - do not read a green Llama column as proof.
 *
 * Deterministic proof, independent of any model's mood: GET /api/quests/{id} afterward and
 * assert promptMeta.offeredTools does NOT contain search_knowledge_base while the file was
 * still unvectorized. That is the live-HTTP signal the gating fix actually landed.
 *
 * Usage:
 *   pnpm --filter @bike4mind/scripts test:kb-refusal \
 *     -- --base-url=https://app.pr<N>.preview.bike4mind.com --trials=10 --arms=gpt-4,meta.llama3-70b-instruct-v1:0
 *
 * Add --search-my-files to also run one "search my files for..." phrased trial per arm,
 * exercising the tool-recommender bypass path (a caller-requested tool survives the
 * auto-offer gate) - this is the wording fix's coverage, not the gate's.
 *
 * Auth: mints a throwaway test user via /api/test/create-user by default - set E2E_CLEANUP_SECRET
 * for the target env. Pass --auth=otc on a PR preview instead: /api/test/create-user 500s there
 * (a stage-config fault), so that mode logs in as the pre-seeded qa-admin-e2e@test.com via OTC.
 * Prerequisites (verify on the target stage, do not assume):
 *   - the `openaiDemoKey` admin setting is populated - OPENAI_API_KEY env is ignored unless
 *     B4M_SELF_HOST=true, so a plain env var is a no-op on any hosted SST stage.
 *   - AWS Bedrock model access granted for the Llama arn/id in $AWS_REGION (default us-east-2),
 *     if running that arm.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type CliArgs = {
  baseUrl: string;
  trials: number;
  arms: string[];
  searchMyFiles: boolean;
  timeoutMs: number;
  outDir: string;
  auth: 'create-user' | 'otc';
};

function parseArgs(): CliArgs {
  const flagPattern = /^--([\w-]+)(?:=(.*))?$/;
  const flags: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(flagPattern);
    if (m) flags[m[1]] = m[2] ?? 'true';
  }
  const baseUrl = (flags['base-url'] ?? process.env.BASE_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('--base-url=<url> or BASE_URL env is required');
  const arms = (flags.arms ?? process.env.ARMS ?? 'gpt-4,meta.llama3-70b-instruct-v1:0')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const auth = flags.auth ?? process.env.AUTH ?? 'create-user';
  if (auth !== 'create-user' && auth !== 'otc') throw new Error(`--auth must be create-user or otc, got: ${auth}`);
  return {
    baseUrl,
    trials: Number(flags.trials ?? process.env.TRIALS ?? 10),
    arms,
    searchMyFiles: flags['search-my-files'] === 'true' || process.env.SEARCH_MY_FILES === '1',
    timeoutMs: Number(flags.timeout ?? process.env.TIMEOUT_MS ?? 60_000),
    outDir: flags['out-dir'] ?? process.env.OUT_DIR ?? path.join(process.cwd(), 'out'),
    auth,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

type HttpInit = RequestInit & { token?: string };

async function httpJson<T>(baseUrl: string, urlPath: string, init: HttpInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${urlPath} -> ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${urlPath} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** Mirrors testAgentExecuteWs.ts's login() - the test-only token-mint path (password login was removed). */
async function loginViaCreateUser(baseUrl: string, label: string): Promise<{ token: string }> {
  const secret = process.env.E2E_CLEANUP_SECRET;
  if (!secret) {
    throw new Error('E2E_CLEANUP_SECRET env is required to mint a test-user token.');
  }
  const stamp = `${Date.now().toString(36)}-${process.pid}-${label}`;
  const username = `kb-refusal-${stamp}`.replace(/[^a-z0-9-]/gi, '');
  const email = `${username}-e2e@test.com`;
  const body = await httpJson<{ accessToken?: string }>(baseUrl, '/api/test/create-user', {
    method: 'POST',
    headers: { 'x-e2e-cleanup-secret': secret },
    body: JSON.stringify({ username, email, name: username, password: 'Testing12345!', isAdmin: false }),
  });
  if (!body.accessToken) throw new Error('create-user response missing accessToken');
  return { token: body.accessToken };
}

/**
 * Preview path: /api/test/create-user 500s on previews (a stage-config fault, not a credential
 * problem), so a preview run logs in as the pre-seeded qa-admin-e2e@test.com via OTC instead.
 * apiAcceptPolicies is not optional - create-user stamps consent for you and OTC does not, so
 * skipping it parks every later request behind the "Before you continue" interstitial.
 */
async function loginViaOtc(baseUrl: string, email = 'qa-admin-e2e@test.com'): Promise<{ token: string }> {
  const secret = process.env.E2E_CLEANUP_SECRET;
  if (!secret) {
    throw new Error('E2E_CLEANUP_SECRET env is required to fetch the OTC code.');
  }
  const sendResponse = await httpJson<{ pendingToken: string }>(baseUrl, '/api/otc/send', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const codeResponse = await httpJson<{ code: string }>(
    baseUrl,
    `/api/test/otc-code?email=${encodeURIComponent(email)}`,
    { headers: { 'x-e2e-cleanup-secret': secret } }
  );
  const verifyResponse = await httpJson<{ accessToken?: string }>(baseUrl, '/api/otc/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code: codeResponse.code, pendingToken: sendResponse.pendingToken }),
  });
  if (!verifyResponse.accessToken) throw new Error('OTC verify response missing accessToken');
  await httpJson(baseUrl, '/api/user/accept-policies', {
    method: 'POST',
    token: verifyResponse.accessToken,
    body: JSON.stringify({ ageAttestation: true }),
  });
  return { token: verifyResponse.accessToken };
}

async function login(baseUrl: string, label: string, auth: 'create-user' | 'otc'): Promise<{ token: string }> {
  return auth === 'otc' ? loginViaOtc(baseUrl) : loginViaCreateUser(baseUrl, label);
}

// Normalizes to NFKC and strips invisible Unicode chars before matching - innerText/model
// output can differ invisibly and break a plain .includes(). Mirrors ai-latency-suite-factory.ts.
function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .toLowerCase();
}

const REFUSAL_PATTERN =
  /cannot access|can't access|do not have access|don't have access|unable to access|no access to|not able to (?:access|read|see)|wasn't provided|was not provided|hasn't been (?:processed|uploaded)|may not have been processed|no indexed content/i;

// ---------------------------------------------------------------------------
// Trial steps
// ---------------------------------------------------------------------------

interface FileResult {
  fileId: string;
  canary: string;
}

async function createUnvectorizedFile(baseUrl: string, token: string, runId: string, n: number): Promise<FileResult> {
  const canaryValue = Math.floor(1000 + Math.random() * 9000);
  const canary = `${canaryValue}`;
  const content = `Zephyr Protocol - internal calibration record.\nThe calibration constant for unit QX-9 is ${canary}.\n`;
  const body = await httpJson<{ id?: string; _id?: string }>(baseUrl, '/api/files/createFabFile', {
    method: 'POST',
    token,
    body: JSON.stringify({
      fileName: `zephyr-${runId}-${n}.txt`,
      mimeType: 'text/plain',
      fileSize: Buffer.byteLength(content, 'utf-8'),
      type: 'FILE',
      content,
    }),
  });
  const fileId = body.id ?? body._id;
  if (!fileId) throw new Error('createFabFile response missing id');
  return { fileId, canary };
}

async function isFileVectorized(baseUrl: string, token: string, fileId: string): Promise<boolean> {
  const results = await httpJson<Array<{ id?: string; _id?: string; vectorized?: boolean }>>(
    baseUrl,
    `/api/files/byIds?ids[]=${encodeURIComponent(fileId)}`,
    { token }
  );
  const file = results.find(f => (f.id ?? f._id) === fileId);
  return Boolean(file?.vectorized);
}

async function createSessionWithAttachment(
  baseUrl: string,
  token: string,
  fileId: string,
  name: string
): Promise<string> {
  const body = await httpJson<{ id?: string; _id?: string }>(baseUrl, '/api/sessions/create', {
    method: 'POST',
    token,
    body: JSON.stringify({ name, knowledgeIds: [fileId] }),
  });
  const id = body.id ?? body._id;
  if (!id) throw new Error('session create response missing id');
  return id;
}

interface ChatResult {
  questId: string;
  response: string;
}

async function askInSameRequest(
  baseUrl: string,
  token: string,
  sessionId: string,
  model: string,
  message: string,
  timeoutMs: number
): Promise<ChatResult> {
  const body = await httpJson<{ id?: string; response?: string; tracking_info?: { quest_id?: string } }>(
    baseUrl,
    '/api/chat',
    {
      method: 'POST',
      token,
      body: JSON.stringify({ sessionId, model, message, wait: true, enableTools: true }),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  const questId = body.tracking_info?.quest_id ?? body.id;
  if (!questId) throw new Error('chat response missing quest id');
  return { questId, response: body.response ?? '' };
}

async function getOfferedTools(baseUrl: string, token: string, questId: string): Promise<string[]> {
  const quest = await httpJson<{ promptMeta?: { offeredTools?: string[] } }>(baseUrl, `/api/quests/${questId}`, {
    token,
  });
  return quest.promptMeta?.offeredTools ?? [];
}

// ---------------------------------------------------------------------------
// Trial runner
// ---------------------------------------------------------------------------

type Verdict = 'PASS' | 'FAIL' | 'INVALID';

interface TrialRecord {
  n: number;
  model: string;
  phrasing: 'plain' | 'search-my-files';
  offeredTools: string[];
  refusalMatched: boolean;
  canaryFound: boolean;
  verdict: Verdict;
  note?: string;
}

async function runTrial(
  args: CliArgs,
  runId: string,
  model: string,
  n: number,
  phrasing: 'plain' | 'search-my-files'
): Promise<TrialRecord> {
  const { token } = await login(args.baseUrl, `${model.replace(/[^a-z0-9]/gi, '')}-${n}-${phrasing}`, args.auth);
  const file = await createUnvectorizedFile(args.baseUrl, token, runId, n);

  // Precondition: the file must genuinely still be unvectorized when we ask about it.
  // Vectorization is an async race - a trial where it already finished is INVALID, not FAIL.
  if (await isFileVectorized(args.baseUrl, token, file.fileId)) {
    return {
      n,
      model,
      phrasing,
      offeredTools: [],
      refusalMatched: false,
      canaryFound: false,
      verdict: 'INVALID',
      note: 'file vectorized before the chat request fired',
    };
  }

  const sessionId = await createSessionWithAttachment(args.baseUrl, token, file.fileId, `kb-refusal-${runId}-${n}`);
  const message =
    phrasing === 'search-my-files'
      ? `Search my files for the calibration constant for unit QX-9.`
      : `What is the calibration constant for unit QX-9 in the attached file?`;

  const { questId, response } = await askInSameRequest(args.baseUrl, token, sessionId, model, message, args.timeoutMs);
  const offeredTools = await getOfferedTools(args.baseUrl, token, questId);

  const normalized = normalizeForMatch(response);
  const refusalMatched = REFUSAL_PATTERN.test(normalized);
  const canaryFound = normalized.includes(file.canary);

  const verdict: Verdict = !refusalMatched && canaryFound ? 'PASS' : 'FAIL';
  return { n, model, phrasing, offeredTools, refusalMatched, canaryFound, verdict };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  console.log(`BASE_URL = ${args.baseUrl}`);
  console.log(`TRIALS   = ${args.trials}`);
  console.log(`ARMS     = ${args.arms.join(', ')}`);
  console.log(`RUN_ID   = ${runId}`);

  const armResults: Record<string, TrialRecord[]> = {};

  // Runs one trial and always pushes a record (a caught error becomes a synthesized FAIL row) so
  // a thrown trial can never silently vanish from the results/summary.
  async function runAndRecord(
    model: string,
    n: number,
    phrasing: 'plain' | 'search-my-files',
    trials: TrialRecord[]
  ): Promise<void> {
    const label = phrasing === 'plain' ? `trial ${n}` : 'search-my-files trial';
    try {
      const record = await runTrial(args, runId, model, n, phrasing);
      trials.push(record);
      console.log(`[${model}] ${label}: ${record.verdict}${record.note ? ` (${record.note})` : ''}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trials.push({
        n,
        model,
        phrasing,
        offeredTools: [],
        refusalMatched: false,
        canaryFound: false,
        verdict: 'FAIL',
        note: message,
      });
      console.error(`[${model}] ${label}: ERROR ${message}`);
    }
  }

  for (const model of args.arms) {
    const trials: TrialRecord[] = [];
    for (let n = 1; n <= args.trials; n++) {
      await runAndRecord(model, n, 'plain', trials);
    }
    if (args.searchMyFiles) {
      await runAndRecord(model, args.trials + 1, 'search-my-files', trials);
    }
    armResults[model] = trials;
  }

  // Deterministic pass criterion, independent of any model's mood: zero trials show
  // search_knowledge_base offered while the file was genuinely unvectorized (INVALID trials
  // are excluded - the precondition already failed there, so the gate was never exercised).
  let anyGateViolation = false;
  const summary: Array<{ model: string; pass: number; fail: number; invalid: number; gateViolations: number }> = [];
  for (const [model, trials] of Object.entries(armResults)) {
    const valid = trials.filter(t => t.verdict !== 'INVALID');
    const pass = valid.filter(t => t.verdict === 'PASS').length;
    const fail = valid.filter(t => t.verdict === 'FAIL').length;
    const invalid = trials.length - valid.length;
    const gateViolations = valid.filter(t => t.offeredTools.includes('search_knowledge_base')).length;
    if (gateViolations > 0) anyGateViolation = true;
    summary.push({ model, pass, fail, invalid, gateViolations });
  }

  console.log('\n---------- summary ----------');
  console.table(summary);
  if (anyGateViolation) {
    console.error('FAIL: search_knowledge_base was offered on at least one trial while the file was unvectorized.');
  }
  for (const row of summary) {
    if (row.invalid >= 3) {
      console.error(`FAIL: ${row.model} had ${row.invalid} invalid trials (>= 3) - run is inconclusive, not green.`);
    }
  }

  mkdirSync(args.outDir, { recursive: true });
  const outPath = path.join(args.outDir, `kb-refusal-${runId}.json`);
  writeFileSync(outPath, JSON.stringify({ runId, args, armResults, summary }, null, 2));
  console.log(`\nWrote ${outPath}`);

  // Rates, not absolute counts - a hardcoded "< 8" or ">= 3" silently stops meaning what it says
  // the moment --trials is anything other than 10.
  const hardFail =
    anyGateViolation ||
    summary.some(r => r.invalid / Math.max(1, r.pass + r.fail + r.invalid) >= 0.3) ||
    // Llama arms are a control (cannot call tools) - do not gate exit status on their pass
    // rate; only fail on a tool-capable arm's pass rate.
    summary.some(
      r => !r.model.toLowerCase().includes('llama') && r.pass + r.fail > 0 && r.pass / (r.pass + r.fail) < 0.8
    );

  if (hardFail) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('FATAL', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
