// Resilient changelog generator — wraps @changesets/changelog-github with
// retry + graceful degradation.
//
// Why this exists (issue #9507):
// `@changesets/changelog-github` enriches changelog entries with PR/author
// links by calling GitHub's GraphQL API through `@changesets/get-github-info`.
// That single `node-fetch` call has no retry, so a transient connection drop —
// classically `Invalid response body ... Premature close` on the Node 24
// runner — throws, and `changeset version[:snapshot]` aborts entirely with
// "We have escaped applying the changesets". The failure is purely cosmetic
// (the version bump itself is unaffected) but surfaces as a red check that
// engineers repeatedly stop to investigate, and it skips the Release version
// PR / npm publish until a clean re-run.
//
// Both the `release` and `snapshot-publish` workflows resolve their changelog
// generator from `.changeset/config.json`, so wrapping it here is the single
// place that hardens both.
//
// Strategy:
//   1. Retry the underlying generator a few times with backoff. On a
//      batch-level fetch throw, `get-github-info`'s DataLoader clears the
//      failed keys, so a retry issues a genuinely fresh GraphQL request.
//      The fixed (non-jittered) backoff keeps concurrent release-line calls
//      aligned on the same tick so they re-batch into one request.
//   2. If every attempt fails, degrade gracefully: emit a plain changelog
//      line built from the changeset summary (no PR/author enrichment) so
//      versioning still completes. A cosmetic GitHub hiccup must never block
//      the release.

// Tolerate both module shapes: @changesets/changelog-github's CJS build exposes
// the changelog object on `.default` (current, 0.7.x), but guard against a future
// release that exports it directly on `module.exports` — otherwise this would be
// `undefined` and every release/snapshot version step would hard-fail.
const changelogGithubModule = require('@changesets/changelog-github');
const githubChangelog = changelogGithubModule.default || changelogGithubModule;

// Backoff schedule in milliseconds. Length === number of attempts after the
// first. Bounded well under the 20-minute job timeout even in the worst case.
const RETRY_DELAYS_MS = [1000, 3000, 8000];

const sleep = (ms) =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

// Run `fn` (a thunk that re-invokes the wrapped generator) with retries.
// `fallback` produces an un-enriched result when every attempt fails.
async function withRetry(label, fn, fallback) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break; // exhausted retries
      console.warn(
        `[changelog-github-retry] ${label} failed (attempt ${attempt + 1}/${
          RETRY_DELAYS_MS.length + 1
        }): ${error && error.message ? error.message : error}. Retrying in ${delay}ms…`
      );
      await sleep(delay);
    }
  }

  console.warn(
    `[changelog-github-retry] ${label} failed after ${
      RETRY_DELAYS_MS.length + 1
    } attempts; falling back to an un-enriched changelog line (no PR/author links). Last error: ${
      lastError && lastError.message ? lastError.message : lastError
    }`
  );
  return fallback();
}

// Mirrors @changesets/changelog-github's release-line shape, minus the GitHub
// enrichment prefix (PR link, commit link, "Thanks @user!"). Strips the
// pr:/commit:/author: metadata directives the same way the real generator does
// so they never leak into the rendered changelog.
function fallbackReleaseLine(changeset) {
  const cleaned = changeset.summary
    .replace(/^\s*(?:pr|pull|pull\s+request):\s*#?(\d+)/im, '')
    .replace(/^\s*commit:\s*([^\s]+)/im, '')
    .replace(/^\s*(?:author|user):\s*@?([^\s]+)/gim, '')
    .trim();
  const [firstLine, ...futureLines] = cleaned.split('\n').map((l) => l.trimEnd());
  return `\n\n- ${firstLine}\n${futureLines.map((l) => `  ${l}`).join('\n')}`;
}

// Degraded form of getDependencyReleaseLine. Upstream emits one
// "- Updated dependencies [<commit-link>]:" line per contributing changeset;
// with GitHub GraphQL hard-down we have no commit links to render, so this
// intentionally collapses to a single un-enriched "- Updated dependencies:"
// header followed by the bumped deps. This shape divergence is deliberate —
// it only fires when enrichment has failed every retry.
function fallbackDependencyReleaseLine(dependenciesUpdated) {
  if (dependenciesUpdated.length === 0) return '';
  const updated = dependenciesUpdated.map(
    (dependency) => `  - ${dependency.name}@${dependency.newVersion}`
  );
  return ['- Updated dependencies:', ...updated].join('\n');
}

const changelogFunctions = {
  getReleaseLine: (changeset, type, options) =>
    withRetry(
      'getReleaseLine',
      () => githubChangelog.getReleaseLine(changeset, type, options),
      () => fallbackReleaseLine(changeset)
    ),
  getDependencyReleaseLine: (changesets, dependenciesUpdated, options) =>
    withRetry(
      'getDependencyReleaseLine',
      () => githubChangelog.getDependencyReleaseLine(changesets, dependenciesUpdated, options),
      () => fallbackDependencyReleaseLine(dependenciesUpdated)
    ),
};

module.exports = changelogFunctions;
module.exports.default = changelogFunctions;
