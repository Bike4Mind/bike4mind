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
  const body = `<!-- preview-e2e -->\n**Advisory preview E2E: ${outcome}**\n\nHead: \`${sha}\`\n\nProjects: ${process.env.PROJECTS || 'Full PR-eligible set (selector fallback)'}\n\n[Workflow run](${runUrl})\n\nThis is not a required check.`;
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

module.exports = { prepare, report, verify, previewStatus };
