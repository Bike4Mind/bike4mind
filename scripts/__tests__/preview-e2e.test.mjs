import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { prepare, report } = require('../../.github/scripts/preview-e2e.cjs');
const root = new URL('../../', import.meta.url);
const sha = 'a'.repeat(40);
function fixture({ eventName = 'status', labels = ['preview-deployed'], state = 'success',
  creator = 'bike4mind-release-bot[bot]', head = sha, statusId = 42 } = {}) {
  const outputs = {};
  const writes = [];
  const pr = { number: 1, state: 'open', head: { sha: head, repo: { full_name: 'Bike4Mind/bike4mind' } },
    base: { sha: 'b'.repeat(40) }, labels: labels.map(name => ({ name })) };
  const status = { id: statusId, context: 'preview/deploy', state, creator: { login: creator } };
  const context = { repo: { owner: 'Bike4Mind', repo: 'bike4mind' }, eventName,
    payload: { ...status, sha, sender: { login: creator } } };
  const github = { rest: { pulls: { get: async () => ({ data: pr }) }, repos: {
    listCommitStatusesForRef: 'statuses', listPullRequestsAssociatedWithCommit: 'prs',
    createCommitStatus: async value => writes.push(value),
  }, issues: { listComments: 'comments', createComment: async value => writes.push(value) } },
  paginate: async method => method === 'statuses' ? [status] : method === 'prs' ? [pr] : [] };
  const core = { setOutput: (key, value) => { outputs[key] = value; }, notice() {}, warning() {} };
  return { github, context, core, outputs, writes };
}

test('current-head App status starts selection even before labels settle', async () => {
  for (const labels of [[], ['preview-deployed'], ['preview-deployed', 'preview-stale']]) {
    const f = fixture({ labels });
    await prepare(f);
    assert.equal(f.outputs.ready, 'true');
    assert.equal(f.outputs.head_sha, sha);
    assert.equal(f.outputs.deploy_id, '42');
  }
});

test('manual label requests require readiness and status events reject stale or untrusted signals', async () => {
  process.env.PR_NUMBER = '1';
  try {
    for (const options of [{ eventName: 'pull_request', labels: [] },
      { eventName: 'pull_request', labels: ['preview-deployed', 'preview-stale'] },
      { state: 'pending' }, { creator: 'github-actions[bot]' }, { head: 'c'.repeat(40) }]) {
      const f = fixture(options);
      await prepare(f);
      assert.equal(f.outputs.ready, undefined, JSON.stringify(options));
    }
  } finally { delete process.env.PR_NUMBER; }
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
    for (const options of [{ head: 'c'.repeat(40) }, { statusId: 43 }, { state: 'pending' }, { labels: [] }]) {
      const f = fixture(options);
      await report(f);
      assert.deepEqual(f.writes, []);
    }
  } finally { process.env = original; }
});

test('actual project configuration guard and path tables run in the existing scripts test lane', () => {
  execFileSync(process.execPath, ['--test', 'apps/client/e2e/project-selection.test.mjs'], { cwd: root });
}, 30_000);

test('preview workflows preserve caps, immutable checkout and full scheduled caller', () => {
  const read = name => readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8');
  const core = read('e2e-core.yml');
  assert.match(core, /timeout_minutes: 20/);
  assert.match(core, /global_timeout_minutes: 15/);
  assert.match(core, /JOB_RESULT: \$\{\{ needs.preview.result \}\}/);
  assert.match(core, /checkout_ref: \$\{\{ needs.prepare-preview.outputs.head_sha \}\}/);
  assert.match(core, /stamp_promotable: false/);
  assert.match(core, /preview:\n\s+needs: \[prepare-preview, select-preview\]\n\s+if: always\(\) && !cancelled\(\)/);
  assert.doesNotMatch(core, /--no-deps/);
  assert.match(read('e2e-on-label.yml'), /uses: \.\/\.github\/workflows\/e2e-core.yml/);
  assert.match(read('e2e-manual.yml'), /schedule:/);
  assert.match(read('e2e-manual.yml'), /""\|"All tests"\)\s+ARGS=""/);
});
