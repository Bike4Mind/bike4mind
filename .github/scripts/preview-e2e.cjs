const DEPLOYER = 'bike4mind-release-bot[bot]';

async function previewStatus(github, repo, pr) {
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
    ...repo, ref: pr.head.sha, per_page: 100,
  });
  const latest = statuses.find(status => status.context === 'preview/deploy');
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo, issue_number: pr.number, per_page: 100,
  });
  const records = comments.filter(comment => comment.user?.login === DEPLOYER)
    .flatMap(comment => {
      const marker = comment.body?.match(/<!-- b4m-preview-deployer (\{[^\n]*\}) -->/);
      try { return marker ? [JSON.parse(marker[1])] : []; } catch { return []; }
    });
  const deployed = records.length === 1 && records[0]?.v === 1 &&
    records[0]?.kind === 'fresh' && records[0]?.sha === pr.head.sha;
  return latest?.state === 'success' && latest.creator?.login === DEPLOYER &&
    deployed &&
    latest.description === `Preview deployed at ${pr.head.sha.slice(0, 7)}` &&
    pr.labels.some(label => label.name === 'preview-deployed') &&
    !pr.labels.some(label => label.name === 'preview-stale') ? latest : null;
}

async function prepare({ github, context, core }) {
  const repo = context.repo;
  if (context.eventName !== 'workflow_dispatch' || context.ref !== 'refs/heads/main') return;
  const number = Number(process.env.PR_NUMBER || 0);
  if (!Number.isSafeInteger(number) || number <= 0) return;
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  if (pr.state !== 'open' || pr.head.repo?.full_name !== `${repo.owner}/${repo.repo}`) return;
  if (pr.mergeable === false) {
    core.notice('PR conflicts with its base; resolve conflicts to run preview E2E.');
    return;
  }
  const status = await previewStatus(github, repo, pr);
  if (!status) {
    core.warning('Preview revision is not verifiable; no tests requested.');
    return;
  }
  core.setOutput('pr_number', String(number));
  core.setOutput('head_sha', pr.head.sha);
  core.setOutput('base_sha', pr.base.sha);
  core.setOutput('deploy_id', String(status.id));
  core.setOutput('full', String(pr.labels.some(label => label.name === 'e2e:full')));
  core.setOutput('ready', 'true');
}

async function verify({ github, context }) {
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(process.env.PR_NUMBER) });
  const status = await previewStatus(github, context.repo, pr);
  if (pr.state !== 'open' || pr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
      pr.head.sha !== process.env.HEAD_SHA || !status || String(status.id) !== process.env.DEPLOY_ID) {
    throw new Error('Preview revision is no longer verifiable; no tests started.');
  }
}

async function report({ github, context, core }) {
  const { stateFor } = await import('../../scripts/e2e-outcome.mjs');
  const number = Number(process.env.PR_NUMBER);
  const sha = process.env.HEAD_SHA;
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  const status = await previewStatus(github, context.repo, pr);
  if (pr.state !== 'open' || pr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
      pr.head.sha !== sha || !status || String(status.id) !== process.env.DEPLOY_ID) {
    core.notice('PR head or preview changed; refusing to publish a stale E2E result.');
    return;
  }
  const result = process.env.JOB_RESULT;
  const outcome = result === 'cancelled' ? 'cancelled' :
    (process.env.OUTCOME || (result === 'failure' ? 'setup_failed' : 'not_run'));
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const body = `<!-- preview-e2e -->\n**Advisory preview E2E: ${outcome}**\n\nHead: \`${sha}\`\n\nProjects: ${process.env.PROJECTS || 'Full PR-eligible set (selector fallback)'}\n\n[Workflow run](${runUrl})\n\nThis is not a required check. Specs run from main; if this PR is behind main, rebase and redeploy before reading a failure.`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: number, per_page: 100,
  });
  const existing = comments.find(comment => comment.user?.login === 'github-actions[bot]' &&
    comment.body?.includes('<!-- preview-e2e -->'));
  if (existing) await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  else await github.rest.issues.createComment({ ...context.repo, issue_number: number, body });
  await github.rest.repos.createCommitStatus({
    ...context.repo, sha, context: 'e2e/preview-advisory', target_url: runUrl,
    state: stateFor(outcome),
    description: `Advisory preview E2E: ${outcome}`,
  });
}

const SLEEP_ROUTE = '/api/test/preview-sleep';

// Wakes a weekend-sleeping preview before the suite runs (route: apps/client/pages/api/test/preview-sleep.ts).
// Messages never carry the secret, the WAF token or a response body.
// deadlineMs keeps the whole check, request time included, inside the workflow step's timeout-minutes: 10.
async function ensureAwake({ apiUrl, secret, wafToken, log, stage = 'preview', fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, attempts = 48, intervalMs = 10000,
  requestTimeoutMs = 15000, deadlineMs = 8 * 60 * 1000 }) {
  if (!secret) {
    log.notice('No E2E secret for this preview; skipping the wake check.');
    return 'skipped';
  }
  if (!apiUrl) throw new Error('API_URL is not set; cannot check whether the preview is asleep.');
  const url = `${apiUrl.replace(/\/$/, '')}${SLEEP_ROUTE}`;
  const headers = { 'x-e2e-cleanup-secret': secret, ...(wafToken ? { 'x-e2e-waf-bypass': wafToken } : {}) };
  const unsupported = () => {
    log.notice('preview sleep route not available on this preview (deployed before it, or sleep disabled); continuing');
    return 'unsupported';
  };
  const refused = status => new Error(status === 401
    ? 'Preview sleep route rejected the E2E secret (HTTP 401); check the derived per-stage secret.'
    : 'Preview sleep route refused the request (HTTP 403); E2E endpoints are off on this stage.');
  // 'unsupported' on 404; null on anything retryable (network error, 5xx, malformed body).
  const readStatus = async () => {
    let res;
    try { res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(requestTimeoutMs) }); } catch { return null; }
    if (res.status === 404) return 'unsupported';
    if (res.status === 401 || res.status === 403) throw refused(res.status);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return typeof body?.asleep === 'boolean' && typeof body?.waking === 'boolean' ? body : null;
  };
  const ready = state => state && state !== 'unsupported' && !state.asleep && !state.waking;

  const started = now();
  let state = await readStatus();
  if (state === 'unsupported') return unsupported();
  if (ready(state)) return 'awake';
  let posted = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (state?.asleep && !posted) {
      let res;
      try {
        res = await fetchImpl(url, { method: 'POST', headers, signal: AbortSignal.timeout(requestTimeoutMs) });
      } catch {
        throw new Error('Waking the preview failed: the wake request did not complete.');
      }
      if (res.status === 404) return unsupported();
      if (res.status === 401 || res.status === 403) throw refused(res.status);
      if (res.status !== 202) throw new Error(`Waking the preview failed (HTTP ${res.status}).`);
      posted = true;
      log.notice('preview was asleep; waking');
    }
    if (now() - started + intervalMs + requestTimeoutMs > deadlineMs) break;
    await wait(intervalMs);
    state = await readStatus();
    if (state === 'unsupported') return unsupported();
    if (ready(state)) return 'woken';
  }
  const elapsed = Math.round((now() - started) / 1000);
  if (state === null) {
    throw new Error(`Preview stage ${stage} status is unknown after ${elapsed}s: the last status check failed ` +
      '(network error, timeout, non-2xx or malformed body); no tests started.');
  }
  throw new Error(`Preview stage ${stage} is still asleep/waking after ${elapsed}s; ` +
    'services did not become ready, no tests started.');
}

module.exports = { prepare, report, verify, previewStatus, ensureAwake };

if (require.main === module) {
  const pr = process.env.PR_NUMBER;
  ensureAwake({
    apiUrl: process.env.API_URL || '',
    secret: process.env.E2E_CLEANUP_SECRET || '',
    wafToken: process.env.E2E_WAF_BYPASS_TOKEN || '',
    stage: pr ? `pr${pr}` : undefined,
    log: { notice: message => console.log(`::notice::${message}`) },
  }).then(outcome => console.log(`Preview wake check: ${outcome}`), error => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
