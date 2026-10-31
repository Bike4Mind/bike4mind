#!/usr/bin/env node
// Blocks a maintainer-configured list of restricted terms from PR text and diffs.
//
// The list comes from the RESTRICTED_TERMS secret: one case-insensitive regex
// fragment per line, matched on word boundaries (camelCase humps count as
// boundaries too; see `WORD_EDGE`). Blank lines and lines starting with `#` are
// ignored. Neither the list nor anything it matches is ever printed,
// because workflow logs on this repo are public: a hit reports only WHERE it was
// found (PR title, commit sha, file and line), never what. A location that would
// itself echo a term (a branch name, a matching file path) is withheld too.
//
// Everything is read through the GitHub REST API, never from a checkout of the
// PR head, so this is safe to run under pull_request_target on fork PRs.
//
// Modes, picked from GITHUB_EVENT_NAME:
//   pull_request_target  title, body, head branch, every commit message, the
//                        added lines of the PR diff and of each commit's own
//                        diff (for a merge, the lines none of its parents
//                        had). Fails on any hit.
//   push                 the same for the pushed commits. Main is already
//                        updated by then, so this only reports.
//   issue_comment, pull_request_review, pull_request_review_comment
//                        the body of the one comment or review the event
//                        carries. On a hit, one nudge comment is posted on the
//                        PR (updated in place on later hits, found by a hidden
//                        marker) naming the author and linking the comment, so
//                        they can edit it. Nothing scans comments later, so the
//                        nudge is the only record of the hit besides this log.
//
// Fails closed: a missing or invalid list, or a PR too large to check
// completely, is a failure rather than a silent pass.

import fs from 'fs';
import { fileURLToPath } from 'url';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const ZERO_SHA = /^0+$/;
// GitHub API caps: pulls/{n}/commits lists at most 250, pulls/{n}/files at most 3000.
const MAX_PR_COMMITS = 250;
const MAX_PR_FILES = 3000;
// compare/{base}...{head} returns at most 300 files.
const MAX_COMPARE_FILES = 300;
// A rate-limited request is retried only while the wait fits well inside the
// workflow's 10-minute timeout; a longer one (an exhausted hourly limit) fails now
// and says so, instead of hanging until the runner kills the job. Times in ms.
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 90_000;
const MAX_RATE_LIMIT_TOTAL_WAIT_MS = 180_000;
// Marks the nudge comment so a later hit on the same PR updates it instead of
// adding another.
const NUDGE_MARKER = '<!-- restricted-terms-nudge -->';
const NUDGE_AUTHOR = 'github-actions[bot]';

// Errors whose message this script wrote and knows to be safe to publish. Any
// other error is reported by name only: a RegExp SyntaxError quotes the pattern
// and a JSON SyntaxError quotes the body it failed on.
class SafeError extends Error {}

function safeMessage(err) {
  return err instanceof SafeError ? err.message : `unexpected ${err?.name ?? 'error'}.`;
}

// Keep edge assertions case-sensitive while fragments match case-insensitively.
// Putting the edge inside the regex lets the engine backtrack to shorter OR
// longer alternatives without slicing away anchors or lookbehind context.
const WORD_EDGE = String.raw`(?-i:(?<![\p{L}\p{N}])|(?![\p{L}\p{N}])|(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L}))`;

/** Folds text and list lines the same way, so an accent or a format character cannot hide a term. */
function fold(s) {
  return (
    s
      .normalize('NFD')
      .replace(/\p{Cf}|\p{Mn}/gu, '')
      // Compatibility mapping can leave a combining mark behind (a halfwidth
      // voiced sound mark after a Latin letter stays one), so strip again.
      .normalize('NFKC')
      .replace(/\p{Cf}|\p{Mn}/gu, '')
  );
}

/**
 * Compiles the term list into a matcher, or throws a message safe to print.
 * The matcher's `test` is boundary-aware (see `WORD_EDGE`), so a term matches
 * inside `term_helper`, `term-cli` and `useTermClient` but not `termination`.
 * Each line is compiled on its own: joined into one pattern, a shorter line that
 * is a prefix of a longer one hides it, as alternation keeps the first match.
 */
export function compileTerms(raw) {
  const fragments = [];
  (raw ?? '').split(/\r?\n/).forEach((line, i) => {
    const fragment = fold(line.trim());
    if (!fragment || fragment.startsWith('#')) return;
    let whole;
    let bounded;
    try {
      whole = new RegExp(fragment, 'iu');
      bounded = new RegExp(`${WORD_EDGE}(?:${fragment})${WORD_EDGE}`, 'iu');
    } catch {
      throw new SafeError(`Line ${i + 1} of the restricted-term list is not a valid regular expression.`);
    }
    const rejectEmpty = () => {
      throw new SafeError(
        `Line ${i + 1} of the restricted-term list matches an empty string, so it would flag every change.`
      );
    };
    if (whole.test('')) rejectEmpty();
    fragments.push(text => {
      const match = bounded.exec(text);
      // Lookarounds can consume nothing only in particular text, even though
      // testing the fragment against an empty string at compile time passed.
      if (match?.[0] === '') rejectEmpty();
      return match !== null;
    });
  });
  if (fragments.length === 0) return null;
  return {
    test(text) {
      // Fold first: fullwidth letters, a zero-width space, a strike-through
      // overlay or an accented letter must not hide a term.
      const folded = fold(text);
      return fragments.some(test => test(folded));
    },
  };
}

/** Tests text against a matcher from `compileTerms`. Folding happens inside `test`. */
export function matches(matcher, text) {
  return matcher.test(text);
}

/** Returns the added lines of a unified diff as `{ line, text }`, numbered in the new file. */
export function addedLines(patch) {
  const out = [];
  let line = 0;
  for (const row of (patch ?? '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
    } else if (row.startsWith('+')) {
      out.push({ line, text: row.slice(1) });
      line++;
    } else if (!row.startsWith('-') && !row.startsWith('\\')) {
      line++;
    }
  }
  return out;
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * Splits file content into `{ line, text }` rows to match. Binary content is
 * still published with the repository, so its printable text is returned
 * instead (with no line numbers). The NUL-stripped view catches UTF-16LE
 * strings, which have a NUL between every character and so never form a
 * printable run on their own.
 */
function contentLines(buffer) {
  if (!isBinary(buffer)) {
    return buffer
      .toString('utf8')
      .split('\n')
      .map((text, i) => ({ line: i + 1, text }));
  }
  const views = [buffer.toString('latin1'), buffer.toString('utf8')];
  return views
    .flatMap(text => [text, text.replace(/\0/g, '')])
    .flatMap(view => view.match(/[^\p{Cc}]+/gu) ?? [])
    .map(run => ({ text: run }));
}

/**
 * How long to wait before retrying a rate-limited response, or undefined when
 * the response is not a rate limit and must fail now. GitHub answers both its
 * primary (hourly) and secondary (burst) limits with 403 or 429; a 403 without
 * a rate-limit signal is a real permission error.
 * https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors
 */
async function rateLimitWaitMs(res, nowMs) {
  if (res.status !== 403 && res.status !== 429) return undefined;
  const retryAfter = Number(res.headers.get('retry-after'));
  if (res.headers.get('retry-after') !== null && Number.isFinite(retryAfter)) return Math.max(retryAfter, 1) * 1000;
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (res.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
    return Math.max(reset * 1000 - nowMs, 0) + 1000;
  }
  if (res.status === 429) return 60_000;
  // A secondary limit may carry no header at all, only its message.
  const body = await res.text().catch(() => '');
  return /rate limit/i.test(body) ? 60_000 : undefined;
}

function github(token, fetchImpl, { sleep, now }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let waitedMs = 0;

  async function request(url, { accept, method = 'GET', body } = {}) {
    const path = url.split('?')[0];
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(url.startsWith('http') ? url : `${API}${url}`, {
        method,
        headers: {
          ...headers,
          ...(accept ? { Accept: accept } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.ok) return res;

      const waitMs = await rateLimitWaitMs(res, now());
      if (waitMs === undefined) {
        const err = new SafeError(`GitHub API ${res.status} for ${path}`);
        err.status = res.status;
        throw err;
      }
      if (
        attempt > MAX_RATE_LIMIT_RETRIES ||
        waitMs > MAX_RATE_LIMIT_WAIT_MS ||
        waitedMs + waitMs > MAX_RATE_LIMIT_TOTAL_WAIT_MS
      ) {
        const err = new SafeError(
          `GitHub API ${res.status} for ${path}: rate limit exceeded, retry in about ${Math.ceil(waitMs / 60_000)} min.`
        );
        err.status = res.status;
        throw err;
      }
      waitedMs += waitMs;
      await sleep(waitMs);
    }
  }

  return {
    json: async url => (await request(url)).json(),
    raw: async url => Buffer.from(await (await request(url, { accept: 'application/vnd.github.raw' })).arrayBuffer()),
    send: async (method, url, body) => (await request(url, { method, body })).json(),
    // `pick` extracts the page's items, for endpoints that wrap them in an object.
    async paginate(url, pick = body => body) {
      const items = [];
      let next = `${url}${url.includes('?') ? '&' : '?'}per_page=100`;
      while (next) {
        const res = await request(next);
        items.push(...pick(await res.json()));
        next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
      }
      return items;
    },
  };
}

async function scanFiles({ files, matcher, gh, repo, ref, hit, note, label = '' }) {
  for (const [index, file] of files.entries()) {
    if (file.status === 'removed') continue;
    const pathHit = matches(matcher, file.filename);
    const where = `${label}${pathHit ? `changed file #${index + 1} (path withheld)` : `file ${file.filename}`}`;
    if (pathHit) hit(`${where}: the file path`);

    let lines;
    if (file.patch !== undefined) {
      lines = addedLines(file.patch);
    } else if (file.changes === 0 && file.status === 'renamed') {
      // A pure rename has no content diff to check. An entry with no counted
      // changes but any other status (a mode change, an added file GitHub did not
      // diff) still has content that was never read, so it is fetched below.
      continue;
    } else {
      // GitHub omits the patch for binary files and for diffs it considers too
      // large. Fetch the whole file at `ref` and check it in full, since its
      // added lines cannot be isolated.
      let content;
      try {
        const path = file.filename.split('/').map(encodeURIComponent).join('/');
        content = await gh.raw(`/repos/${repo}/contents/${path}?ref=${ref}`);
      } catch (err) {
        note(`${where}: could not fetch content to check (HTTP ${err.status ?? 'error'}).`);
        continue;
      }
      lines = contentLines(content);
    }
    for (const { line, text } of lines) {
      if (matches(matcher, text)) hit(line === undefined ? `${where} (binary text)` : `${where} line ${line}`);
    }
  }
}

/**
 * Splits a complete `?recursive=1` listing of `rootSha` (entries carry full
 * paths) into one name-keyed listing per directory, cached by tree sha in the
 * same shape a non-recursive listing gives.
 */
function cacheRecursiveListing(trees, rootSha, entries) {
  const shaOfDir = new Map([['', rootSha]]);
  for (const entry of entries) if (entry.type === 'tree') shaOfDir.set(entry.path, entry.sha);
  const listings = new Map([...shaOfDir.values()].map(sha => [sha, new Map()]));
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');
    const name = entry.path.slice(slash + 1);
    listings.get(shaOfDir.get(entry.path.slice(0, Math.max(slash, 0)))).set(name, { ...entry, path: name });
  }
  for (const [sha, listing] of listings) if (!trees.has(sha)) trees.set(sha, listing);
}

/**
 * Lists the blobs a merge commit changed relative to EVERY parent, as
 * `{ path, sha, parentShas }`, where `parentShas` are the parents' blobs at the
 * same path. A file or directory identical to one parent's holds nothing that
 * parent did not already have, so the walk descends only into directories that
 * differ from all parents. Read from git trees, so unlike compare (300 files)
 * the result is never capped by the size of the branches being merged.
 */
async function mergeOnlyBlobs({ commit, gh, repo, incomplete, trees }) {
  // One recursive listing caches every directory under a root, so a merge costs a
  // request per root tree instead of one per directory the walk descends into
  // (over a thousand on a long-lived branch, past the token's hourly budget).
  const entriesOf = async sha => {
    if (sha === undefined) return new Map();
    if (!trees.has(sha)) {
      const listing = await gh.json(`/repos/${repo}/git/trees/${sha}?recursive=1`);
      if (listing.truncated) {
        // Too large for one response: list this directory alone and let the walk
        // fetch the subdirectories it needs.
        const tree = await gh.json(`/repos/${repo}/git/trees/${sha}`);
        // The directory path is withheld: it may itself contain a term.
        if (tree.truncated) incomplete(`merge ${commit.sha.slice(0, 12)} has a directory too large to list.`);
        trees.set(sha, new Map((tree.tree ?? []).map(entry => [entry.path, entry])));
      } else {
        cacheRecursiveListing(trees, sha, listing.tree ?? []);
      }
    }
    return trees.get(sha);
  };

  const blobs = [];
  const walk = async (dir, treeSha, parentTreeShas) => {
    const [own, ...parents] = await Promise.all([treeSha, ...parentTreeShas].map(entriesOf));
    for (const [name, entry] of own) {
      const inParents = parents.map(entries => entries.get(name));
      if (inParents.some(parentEntry => parentEntry?.sha === entry.sha)) continue;
      const shasOfType = type =>
        inParents.map(parentEntry => (parentEntry?.type === type ? parentEntry.sha : undefined));
      if (entry.type === 'tree') {
        await walk(`${dir}${name}/`, entry.sha, shasOfType('tree'));
      } else if (entry.type === 'blob') {
        blobs.push({ path: `${dir}${name}`, sha: entry.sha, parentShas: shasOfType('blob').filter(Boolean) });
      }
      // A submodule ('commit') entry is only a pointer, with no content to read.
    }
  };
  // A commit sha resolves to its root tree.
  await walk(
    '',
    commit.sha,
    commit.parents.map(parent => parent.sha)
  );
  return blobs;
}

/**
 * Scans what a merge commit itself introduced: lines present in none of its
 * parents' versions of a file, i.e. conflict resolutions and edits made in the
 * merge. Content either parent already had is not charged to it; PR-side
 * content was checked through the commits that added it, base-side content is
 * not the PR's.
 */
async function scanMergeCommit({ commit, matcher, gh, repo, hit, incomplete, trees }) {
  const label = `commit ${commit.sha.slice(0, 12)} `;
  const readBlob = async sha => {
    const blob = await gh.json(`/repos/${repo}/git/blobs/${sha}`);
    return Buffer.from(blob.content ?? '', blob.encoding === 'base64' ? 'base64' : 'utf8');
  };

  const blobs = await mergeOnlyBlobs({ commit, gh, repo, incomplete, trees });
  for (const [index, blob] of blobs.entries()) {
    const pathHit = matches(matcher, blob.path);
    const where = `${label}${pathHit ? `merged file #${index + 1} (path withheld)` : `file ${blob.path}`}`;
    // A path any parent already had is inherited, not introduced by the merge.
    if (pathHit && blob.parentShas.length === 0) hit(`${where}: the file path`);

    const matching = contentLines(await readBlob(blob.sha)).filter(({ text }) => matches(matcher, text));
    if (matching.length === 0) continue;
    const parentContents = await Promise.all(blob.parentShas.map(readBlob));
    const inherited = new Set(parentContents.flatMap(content => contentLines(content).map(({ text }) => text)));
    for (const { line, text } of matching) {
      if (inherited.has(text)) continue;
      hit(line === undefined ? `${where} (binary text)` : `${where} line ${line}`);
    }
  }
}

// Net diffs miss additions later removed, including merge resolutions. Scan
// every commit's own diff, and for a merge only what it added beyond its parents.
async function scanCommitDiffs({ commits, matcher, gh, repo, hit, incomplete }) {
  if (commits.length < 2) return;
  // Shared across merges: tree shas are content-addressed, and repeated merges of
  // the base branch see mostly the same unchanged subtrees.
  const trees = new Map();
  for (const c of commits) {
    if (c.parents?.length > 1) {
      await scanMergeCommit({ commit: c, matcher, gh, repo, hit, incomplete, trees });
      continue;
    }
    const sha = c.sha.slice(0, 12);
    const files = await gh.paginate(`/repos/${repo}/commits/${c.sha}`, body => body.files ?? []);
    if (files.length >= MAX_PR_FILES) {
      incomplete(`commit ${sha} changes ${MAX_PR_FILES}+ files; the API lists only ${MAX_PR_FILES}.`);
    }
    await scanFiles({ files, matcher, gh, repo, ref: c.sha, hit, note: incomplete, label: `commit ${sha} ` });
  }
}

async function scanPullRequest({ event, matcher, gh, repo, hit, incomplete }) {
  const pr = await gh.json(`/repos/${repo}/pulls/${event.pull_request.number}`);
  if (matches(matcher, pr.title ?? '')) hit('PR title');
  if (matches(matcher, pr.body ?? '')) hit('PR body');
  if (matches(matcher, pr.head.ref ?? '')) hit('head branch name');

  if (pr.commits > MAX_PR_COMMITS) {
    incomplete(`The PR has ${pr.commits} commits; the API lists only ${MAX_PR_COMMITS}. Split or squash it.`);
  }
  const commits = await gh.paginate(`/repos/${repo}/pulls/${pr.number}/commits`);
  for (const c of commits) {
    if (matches(matcher, c.commit.message ?? '')) hit(`commit ${c.sha.slice(0, 12)} message`);
  }

  if (pr.changed_files > MAX_PR_FILES) {
    incomplete(`The PR changes ${pr.changed_files} files; the API lists only ${MAX_PR_FILES}. Split it.`);
  }
  const files = await gh.paginate(`/repos/${repo}/pulls/${pr.number}/files`);
  await scanFiles({ files, matcher, gh, repo, ref: pr.head.sha, hit, note: incomplete });
  await scanCommitDiffs({ commits, matcher, gh, repo, hit, incomplete });
  return `PR #${pr.number}: title, body, branch name, ${commits.length} commit(s), ${files.length} file(s)`;
}

async function scanPush({ event, matcher, gh, repo, hit, incomplete }) {
  let commits;
  let files;
  try {
    if (ZERO_SHA.test(event.before)) throw Object.assign(new Error('new ref'), { status: 404 });
    const cmp = await gh.json(`/repos/${repo}/compare/${event.before}...${event.after}`);
    commits = cmp.commits;
    files = cmp.files ?? [];
    if ((cmp.total_commits ?? commits.length) > commits.length) {
      incomplete(`The push has ${cmp.total_commits} commits; only the first ${commits.length} were listed.`);
    }
    if (files.length >= MAX_COMPARE_FILES) {
      incomplete(`The push changes ${MAX_COMPARE_FILES}+ files; only the first ${MAX_COMPARE_FILES} were checked.`);
    }
  } catch (err) {
    // A force push or a new ref has no usable base; check the head commit,
    // but report the gap because neither path enumerates the earlier history.
    if (err.status !== 404) throw err;
    incomplete(
      ZERO_SHA.test(event.before)
        ? 'the new ref history was not listed; only the head commit was checked.'
        : 'the push base is not comparable; only the head commit was checked.'
    );
    const head = await gh.json(`/repos/${repo}/commits/${event.after}`);
    commits = [head];
    files = await gh.paginate(`/repos/${repo}/commits/${event.after}`, body => body.files ?? []);
  }
  for (const c of commits) {
    if (matches(matcher, c.commit.message ?? '')) hit(`commit ${c.sha.slice(0, 12)} message`);
  }
  await scanFiles({ files, matcher, gh, repo, ref: event.after, hit, note: incomplete });
  await scanCommitDiffs({ commits, matcher, gh, repo, hit, incomplete });
  return `push to ${event.ref}: ${commits.length} commit(s), ${files.length} file(s)`;
}

/**
 * The comment or review a comment event carries, or `{ skip }` with the reason
 * there is nothing to check. A review submitted with inline comments only has
 * an empty body (its state is `commented`); the inline comments arrive as
 * their own events.
 */
function commentOf(eventName, event) {
  if (eventName === 'issue_comment') {
    if (!event.issue?.pull_request) return { skip: 'the comment is on an issue, not a pull request' };
    const { comment, issue } = event;
    return {
      kind: 'comment',
      body: comment.body,
      url: comment.html_url,
      login: comment.user?.login,
      number: issue.number,
    };
  }
  if (eventName === 'pull_request_review') {
    const { review, pull_request: pr } = event;
    if (!review.body) return { skip: 'the review has no text' };
    return { kind: 'review', body: review.body, url: review.html_url, login: review.user?.login, number: pr.number };
  }
  const { comment, pull_request: pr } = event;
  return {
    kind: 'review comment',
    body: comment.body,
    url: comment.html_url,
    login: comment.user?.login,
    number: pr.number,
  };
}

function scanComment({ eventName, event, matcher, hit }) {
  const comment = commentOf(eventName, event);
  if (comment.skip) return { comment, summary: null };
  // A login could itself be a term; the link still says whose comment it is.
  comment.who = comment.login && !matches(matcher, comment.login) ? ` by @${comment.login}` : '';
  const where = `${comment.kind}${comment.who} (${comment.url})`;
  if (matches(matcher, comment.body ?? '')) hit(where);
  return { comment, summary: `PR #${comment.number}: ${where}` };
}

/**
 * Posts the nudge for a hit comment on its PR, or rewrites the one already
 * there so the PR carries a single nudge pointing at the latest hit. The
 * check's own failure is only visible on the Checks tab, which the comment's
 * author may never open.
 */
async function nudge({ gh, repo, comment }) {
  const body =
    `${NUDGE_MARKER}\nThe Restricted Terms check found a restricted term in a [${comment.kind}](${comment.url})` +
    `${comment.who}. Please edit it to remove the term (the matched text is deliberately not shown; ` +
    'the list is maintained by the repository maintainers). The check runs again on the edit.';
  const comments = await gh.paginate(`/repos/${repo}/issues/${comment.number}/comments`);
  const existing = comments.find(c => c.user?.login === NUDGE_AUTHOR && c.body?.includes(NUDGE_MARKER));
  if (existing) {
    await gh.send('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
  } else {
    await gh.send('POST', `/repos/${repo}/issues/${comment.number}/comments`, { body });
  }
}

/** Runs the check and returns its exit code; every line it logs is safe to publish. */
export async function run({
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
  readFile = fs.readFileSync,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  // Paths in a message come from the PR. Git allows a newline in a path, and an
  // unescaped one would start a line the runner parses as a workflow command.
  const annotate = (level, msg) =>
    log(`::${level}::${msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  const fail = msg => {
    annotate('error', msg);
    return 1;
  };

  let matcher;
  try {
    matcher = compileTerms(env.RESTRICTED_TERMS);
  } catch (err) {
    return fail(safeMessage(err));
  }
  if (!matcher) {
    return fail(
      'The RESTRICTED_TERMS secret is missing or empty, so nothing can be checked. ' +
        'A maintainer must set it under Settings > Secrets and variables > Actions. ' +
        'This check fails until then.'
    );
  }
  if (!env.GITHUB_TOKEN) return fail('GITHUB_TOKEN is not set.');

  const eventName = env.GITHUB_EVENT_NAME;
  const event = JSON.parse(readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const gh = github(env.GITHUB_TOKEN, fetchImpl, { sleep, now });
  const repo = env.GITHUB_REPOSITORY;

  const hits = [];
  const gaps = [];
  const ctx = { event, matcher, gh, repo, hit: where => hits.push(where), incomplete: why => gaps.push(why) };

  const isCommentEvent = ['issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(eventName);
  let summary;
  let comment;
  try {
    if (eventName === 'pull_request_target' || eventName === 'pull_request') {
      summary = await scanPullRequest(ctx);
    } else if (eventName === 'push') {
      summary = await scanPush(ctx);
    } else if (isCommentEvent) {
      ({ comment, summary } = scanComment({ eventName, ...ctx }));
      if (!summary) {
        log(`Nothing to check: ${comment.skip}.`);
        return 0;
      }
    } else {
      log(`Nothing to check for ${eventName} events.`);
      return 0;
    }
  } catch (err) {
    return fail(`Restricted-term check could not complete: ${safeMessage(err)}`);
  }

  log(`Checked ${summary}.`);
  const isPush = eventName === 'push';
  for (const why of gaps) annotate('error', `Incomplete check: ${why}`);
  for (const where of hits) annotate('error', `Restricted term found in ${where}.`);

  if (hits.length > 0) {
    log(
      `${hits.length} restricted-term hit(s). The matched text is deliberately not shown. ` +
        (isPush
          ? 'This push is already on the branch: a maintainer must follow up.'
          : isCommentEvent
            ? 'The author must edit the comment to remove it.'
            : 'Remove it from the locations above (rewrite commit messages if needed) and push again.')
    );
    if (isCommentEvent) {
      try {
        await nudge({ gh, repo, comment });
        log('Posted a nudge comment on the PR.');
      } catch (err) {
        annotate('warning', `Could not post the nudge comment on the PR: ${safeMessage(err)}`);
      }
    }
    return 1;
  }
  // A push already landed, but a partial check must still go red, or a large
  // push would pass the backstop green without being read.
  if (gaps.length > 0) return 1;
  log('No restricted terms found.');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(
    code => process.exit(code),
    err => {
      console.log(`::error::Restricted-term check could not complete: ${safeMessage(err)}`);
      process.exit(1);
    }
  );
}
