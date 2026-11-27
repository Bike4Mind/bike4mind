import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { stateFor } from '../e2e-outcome.mjs';

const require = createRequire(import.meta.url);
const { prepare, report, verify, ensureAwake } = require('../../.github/scripts/preview-e2e.cjs');
const root = new URL('../../', import.meta.url);
const sha = 'a'.repeat(40);
const movedHead = { head: 'c'.repeat(40), description: `Preview deployed at ${'c'.repeat(7)}`, deployedSha: 'c'.repeat(40) };
function fixture({ eventName = 'workflow_dispatch', ref = 'refs/heads/main', labels = ['preview-deployed'], state = 'success',
  creator = 'bike4mind-release-bot[bot]', head = sha, statusId = 42, mergeable = true,
  description = `Preview deployed at ${sha.slice(0, 7)}`, deployedSha = sha, kind = 'fresh', recordAuthor = creator } = {}) {
  const outputs = {};
  const writes = [];
  const notices = [];
  const pr = { number: 1, state: 'open', head: { sha: head, repo: { full_name: 'Bike4Mind/bike4mind' } },
    base: { sha: 'b'.repeat(40) }, mergeable, labels: labels.map(name => ({ name })) };
  const status = { id: statusId, context: 'preview/deploy', state, description, creator: { login: creator } };
  const context = { repo: { owner: 'Bike4Mind', repo: 'bike4mind' }, eventName, ref,
    payload: { ...status, sha, sender: { login: creator } } };
  const github = { rest: { pulls: { get: async () => ({ data: pr }) }, repos: {
    listCommitStatusesForRef: 'statuses', listPullRequestsAssociatedWithCommit: 'prs',
    createCommitStatus: async value => writes.push(value),
  }, issues: { listComments: 'comments', createComment: async value => writes.push(value) } },
  paginate: async method => method === 'statuses' ? [status] : method === 'prs' ? [pr] : [{
    user: { login: recordAuthor }, body: `<!-- b4m-preview-deployer ${JSON.stringify({ v: 1, sha: deployedSha, kind })} -->`,
  }] };
  const core = { setOutput: (key, value) => { outputs[key] = value; }, notice: message => notices.push(message), warning() {} };
  return { github, context, core, outputs, writes, notices };
}

test('main dispatch with only pr_number prepares the selected advisory route', async () => {
  process.env.PR_NUMBER = '1';
  try {
    const f = fixture();
    await prepare(f);
    assert.equal(f.outputs.ready, 'true');
    assert.equal(f.outputs.head_sha, sha);
    assert.equal(f.outputs.deploy_id, '42');
  } finally { delete process.env.PR_NUMBER; }
});

test('conflicted PRs are skipped with a notice and uncomputed mergeability still runs', async () => {
  process.env.PR_NUMBER = '1';
  try {
    const conflicted = fixture({ mergeable: false });
    await prepare(conflicted);
    assert.equal(conflicted.outputs.ready, undefined);
    assert.equal(conflicted.notices.length, 1);
    assert.match(conflicted.notices[0], /conflicts with its base/);
    const pending = fixture({ mergeable: null });
    await prepare(pending);
    assert.equal(pending.outputs.ready, 'true');
  } finally { delete process.env.PR_NUMBER; }
});

test('dispatch fails closed on stale, missing or untrusted deployment evidence', async () => {
  process.env.PR_NUMBER = '1';
  try {
    for (const options of [{ labels: [] }, { labels: ['preview-deployed', 'preview-stale'] },
      { eventName: 'status' }, { eventName: 'pull_request' }, { ref: 'refs/heads/feature' },
      { description: 'Preview is 1 commits behind (running aaaaaaa)' }, { description: '' },
      { kind: 'deploying' }, { deployedSha: 'c'.repeat(40) }, { recordAuthor: 'someone' },
      { state: 'pending' }, { creator: 'attacker', recordAuthor: 'bike4mind-release-bot[bot]' }]) {
      const f = fixture(options);
      await prepare(f);
      assert.equal(f.outputs.ready, undefined, JSON.stringify(options));
    }
  } finally { delete process.env.PR_NUMBER; }
});

test('execution revalidates the same full deployment evidence and status id', async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, { PR_NUMBER: '1', HEAD_SHA: sha, DEPLOY_ID: '42' });
    await verify(fixture());
    for (const options of [{ statusId: 43 }, movedHead, { deployedSha: 'c'.repeat(40) },
      { description: 'Preview is 1 commits behind (running aaaaaaa)' }, { kind: 'deploying' }]) {
      await assert.rejects(verify(fixture(options)), /no tests started/);
    }
  } finally { process.env = original; }
});

test('report fallback never turns missing reusable outputs into a pass, and suppresses stale results', async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, { PR_NUMBER: '1', HEAD_SHA: sha, DEPLOY_ID: '42', OUTCOME: '' });
    for (const [JOB_RESULT, expected] of [['failure', 'setup_failed'], ['cancelled', 'cancelled'], ['success', 'not_run']]) {
      process.env.JOB_RESULT = JOB_RESULT;
      const f = fixture();
      await report(f);
      assert.match(f.writes[0].body, new RegExp(expected));
      assert.notEqual(f.writes[1].state, 'success');
    }
    for (const options of [movedHead, { statusId: 43 }, { state: 'pending' }, { labels: [] }]) {
      const f = fixture(options);
      await report(f);
      assert.deepEqual(f.writes, []);
    }
  } finally { process.env = original; }
});

test('actual project configuration guard and path tables run in the existing scripts test lane', () => {
  execFileSync(process.execPath, ['--test', 'apps/client/e2e/project-selection.test.mjs'], { cwd: root, stdio: 'inherit' });
}, 30_000);

test('preview statuses use the shared outcome state mapping', async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, { PR_NUMBER: '1', HEAD_SHA: sha, DEPLOY_ID: '42', JOB_RESULT: 'success' });
    for (const outcome of ['passed', 'failed', 'setup_failed', 'no_tests', 'incomplete', 'not_run', 'skipped', 'cancelled']) {
      process.env.OUTCOME = outcome;
      const f = fixture();
      await report(f);
      assert.equal(f.writes[1].state, stateFor(outcome));
    }
  } finally { process.env = original; }
});

test('preview dispatch executes trusted main only, fetches diff data and preserves staging', () => {
  const read = name => readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8');
  const core = read('e2e-core.yml');
  assert.match(core, /timeout_minutes: 45/);
  assert.match(core, /global_timeout_minutes: 15/);
  assert.match(core, /JOB_RESULT: \$\{\{ needs.preview.result \}\}/);
  assert.doesNotMatch(core + read('e2e-run.yml'), new RegExp('checkout' + '_ref'));
  assert.equal([...core.matchAll(/ref: \$\{\{ github.sha \}\}/g)].length, 3);
  assert.match(core, /git fetch --no-tags origin "\$E2E_BASE_SHA" "\$E2E_HEAD_SHA"/);
  assert.match(core, /pnpm --filter @bike4mind\/client exec tsx e2e\/select-projects.ts/);
  assert.doesNotMatch(core, /refs\/pull\/|ref: .*head_sha|ref: .*base_sha|\n\s+status:|\n\s+pull_request:|workflow_call:/);
  assert.match(core, /github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main' && inputs.pr_number != ''/);
  assert.match(core, /core:\n\s+if: github.event_name == 'workflow_dispatch' && inputs.pr_number == ''/);
  assert.match(core, /playwright_args:\s+'--project=unauthenticated --project=notebook --project=prompts'/);
  assert.match(core, /preview_head_sha: \$\{\{ needs.prepare-preview.outputs.head_sha \}\}/);
  assert.match(read('e2e-run.yml'), /HEAD_SHA: \$\{\{ inputs.preview_head_sha \}\}/);
  assert.doesNotMatch(core + read('e2e-run.yml'), /git rev-parse HEAD\^2/);
  assert.match(core, /execution_timeout_minutes: 17/);
  assert.match(core, /timeout_minutes: {4}60\n\s+execution_timeout_minutes: 28/);
  assert.match(read('e2e-run.yml'), /timeout-minutes: \$\{\{ inputs.execution_timeout_minutes \}\}/);
  assert.match(core, /stamp_promotable: false/);
  assert.match(core, /preview:\n\s+needs: \[prepare-preview, select-preview\]\n\s+if: always\(\) && !cancelled\(\)/);
  assert.doesNotMatch(core, /--no-deps/);
  assert.doesNotMatch(read('e2e-on-label.yml'), /pull_request:|types: \[labeled\]/);
  assert.match(read('e2e-on-label.yml'), /workflow_dispatch:/);
  assert.match(read('e2e-on-label.yml'), /workflow_id: 'e2e-core.yml', ref: 'main'/);
  assert.match(read('e2e-run.yml'), /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+ref: \$\{\{ github.sha \}\}/);
  assert.match(read('e2e-run.yml'), /TRUSTED_PREVIEW:.*github.ref == 'refs\/heads\/main'.*inputs.preview_deploy_id != ''.*inputs.preview_head_sha != ''/);
  assert.match(read('e2e-run.yml'), /\.verify\(\{ github, context \}\)/);
  const run = read('e2e-run.yml');
  const verifyAt = run.indexOf('- name: Verify immutable preview readiness');
  const wakeAt = run.indexOf('- name: Wake a sleeping preview before testing');
  const testsAt = run.indexOf('- name: Run E2E tests');
  assert.ok(verifyAt >= 0 && verifyAt < wakeAt && wakeAt < testsAt, 'wake step sits between readiness verify and the test run');
  const wake = run.slice(wakeAt, run.indexOf('\n      - name:', wakeAt + 1));
  assert.match(wake, /if: inputs.pr_number != '' && inputs.preview_deploy_id != ''/);
  assert.match(wake, /timeout-minutes: 10\n/);
  assert.match(wake, /\. \.github\/scripts\/derive-preview-e2e-secret.sh "\$SST_STAGE"\n\s+node \.github\/scripts\/preview-e2e.cjs/);
  assert.match(read('e2e-manual.yml'), /schedule:/);
  assert.match(read('e2e-manual.yml'), /""\|"All tests"\)\s+ARGS=""/);
  assert.match(read('e2e-manual.yml'), /timeout_minutes: {4}85\n\s+global_timeout_minutes: 50\n\s+execution_timeout_minutes: 52/);
});

test('no e2e workflow checkout ref can come from inputs or PR refs', () => {
  const dir = new URL('.github/workflows/', root);
  const files = readdirSync(dir).filter(name => /^e2e.*\.yml$/.test(name));
  let seen = 0;
  for (const name of files) {
    const lines = readFileSync(new URL(name, dir), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/uses: actions\/checkout@/.test(line)) return;
      for (const next of lines.slice(index + 1)) {
        if (/^\s*-\s/.test(next) && !/^\s+- uses/.test(next)) break;
        const ref = next.match(/^\s+ref:\s*(.+)$/)?.[1];
        if (ref === undefined) continue;
        seen += 1;
        assert.equal(ref.trim(), '${{ github.sha }}', `${name}: ${ref}`);
        assert.doesNotMatch(ref, /inputs\.|head|pull|refs\/pull/, `${name}: ${ref}`);
        break;
      }
    });
  }
  assert.ok(seen >= 4);
});

const SECRET = 'secret-value-123';
const WAF = 'waf-token-456';
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const asleep = json(200, { asleep: true, waking: false, services: [] });
const waking = json(200, { asleep: false, waking: true, services: [] });
const awake = json(200, { asleep: false, waking: false, services: [] });
function wake(responses, overrides = {}) {
  const calls = [];
  const notices = [];
  const queue = [...responses];
  let clock = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, signal: init.signal });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const run = ensureAwake({ apiUrl: 'https://api.example.com/', secret: SECRET, wafToken: WAF, stage: 'pr7',
    log: { notice: message => notices.push(message) }, fetchImpl, wait: async ms => { clock += ms; }, now: () => clock,
    attempts: 3, intervalMs: 10000,
    ...overrides });
  return { run, calls, notices, posts: () => calls.filter(call => call.method === 'POST').length };
}
const noLeak = (...texts) => texts.forEach(text => {
  assert.doesNotMatch(text, new RegExp(`${SECRET}|${WAF}`));
});

test('ensureAwake passes an awake preview through with one GET and no POST', async () => {
  const w = wake([awake]);
  assert.equal(await w.run, 'awake');
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].url, 'https://api.example.com/api/test/preview-sleep');
  assert.deepEqual(w.calls[0].headers, { 'x-e2e-cleanup-secret': SECRET, 'x-e2e-waf-bypass': WAF });
});

test('ensureAwake wakes an asleep preview once and polls until ready', async () => {
  const w = wake([asleep, json(202, { waking: true }), waking, awake]);
  assert.equal(await w.run, 'woken');
  assert.equal(w.posts(), 1);
  assert.deepEqual(w.notices, ['preview was asleep; waking']);
});

test('ensureAwake polls a waking preview without posting', async () => {
  const w = wake([waking, waking, awake]);
  assert.equal(await w.run, 'woken');
  assert.equal(w.posts(), 0);
});

test('ensureAwake fails with the asleep message once the budget runs out', async () => {
  const w = wake([asleep, json(202, {}), asleep, waking, waking]);
  await assert.rejects(w.run, error => {
    assert.match(error.message, /Preview stage pr7 is still asleep\/waking after 30s; .*no tests started/);
    noLeak(error.message);
    return true;
  });
  assert.equal(w.posts(), 1);
});

test('ensureAwake treats a 404 on GET or POST (older or sleep-disabled preview) as unsupported', async () => {
  for (const responses of [[json(404, {})], [asleep, json(404, {})]]) {
    const w = wake(responses);
    assert.equal(await w.run, 'unsupported');
    assert.deepEqual(w.notices,
      ['preview sleep route not available on this preview (deployed before it, or sleep disabled); continuing']);
  }
});

test('ensureAwake stops at the wall-clock deadline, reserving time for the next request', async () => {
  // 35s deadline: a third poll at 30s would fit the interval but not its 15s request timeout.
  const w = wake([asleep, json(202, {}), asleep, asleep, asleep], { attempts: 48, deadlineMs: 35000 });
  await assert.rejects(w.run, /still asleep\/waking after 20s/);
  assert.equal(w.calls.filter(call => call.method === 'GET').length, 3);
});

test('ensureAwake reports an unknown status when the last poll failed', async () => {
  const w = wake([json(502, {}), new Error('fetch failed'), json(502, {}), json(503, {})]);
  await assert.rejects(w.run, error => {
    assert.match(error.message, /Preview stage pr7 status is unknown after 30s: .*no tests started/);
    assert.doesNotMatch(error.message, /still asleep/);
    return true;
  });
});

test('ensureAwake bounds every request with an abort signal', async () => {
  const w = wake([asleep, json(202, {}), awake]);
  await w.run;
  assert.equal(w.calls.length, 3);
  for (const call of w.calls) assert.ok(call.signal instanceof AbortSignal);
});

test('ensureAwake throws a clear error on 401 and 403', async () => {
  await assert.rejects(wake([json(401, {})]).run, /rejected the E2E secret \(HTTP 401\)/);
  await assert.rejects(wake([asleep, json(403, {})]).run, /E2E endpoints are off/);
});

test('ensureAwake retries a transient 502, a network error and a malformed body', async () => {
  const w = wake([json(502, { error: 'Preview status is unavailable' }), new Error('fetch failed'),
    json(200, { asleep: 'yes' }), awake], { attempts: 5 });
  assert.equal(await w.run, 'woken');
  assert.equal(w.posts(), 0);
});

test('ensureAwake omits the WAF header without a token and skips without a secret', async () => {
  const w = wake([awake], { wafToken: '' });
  await w.run;
  assert.deepEqual(w.calls[0].headers, { 'x-e2e-cleanup-secret': SECRET });
  const skipped = wake([], { secret: '' });
  assert.equal(await skipped.run, 'skipped');
  assert.equal(skipped.calls.length, 0);
});

test('ensureAwake keeps the secret and token out of every message', async () => {
  const w = wake([asleep, json(500, { error: SECRET })]);
  await assert.rejects(w.run, error => (noLeak(error.message, ...w.notices), /HTTP 500/.test(error.message)));
});
