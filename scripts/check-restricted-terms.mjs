#!/usr/bin/env node
// Blocks a maintainer-configured list of restricted terms from PR text and diffs.
//
// The list comes from the RESTRICTED_TERMS secret: one case-insensitive regex
// fragment per line, matched on word boundaries. Blank lines and lines starting
// with `#` are ignored. Neither the list nor anything it matches is ever printed,
// because workflow logs on this repo are public: a hit reports only WHERE it was
// found (PR title, commit sha, file and line), never what. A location that would
// itself echo a term (a branch name, a matching file path) is withheld too.
//
// Everything is read through the GitHub REST API, never from a checkout of the
// PR head, so this is safe to run under pull_request_target on fork PRs.
//
// Modes, picked from GITHUB_EVENT_NAME:
//   pull_request_target  title, body, head branch, every commit message, the
//                        added lines of every changed file. Fails on any hit.
//   push                 commit messages and added lines of the push. Main is
//                        already updated by then, so this only reports.
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

// Errors whose message this script wrote and knows to be safe to publish. Any
// other error is reported by name only: a RegExp SyntaxError quotes the pattern
// and a JSON SyntaxError quotes the body it failed on.
class SafeError extends Error {}

function safeMessage(err) {
  return err instanceof SafeError ? err.message : `unexpected ${err?.name ?? 'error'}.`;
}

/**
 * Compiles the term list into a single matcher, or throws a message safe to print.
 * Word boundaries are letters and digits only, so `_`, `-`, `/` and `.` separate
 * words: a term matches inside `term_helper` and `term-cli` but not `termination`.
 */
export function compileTerms(raw) {
  const fragments = [];
  (raw ?? '').split(/\r?\n/).forEach((line, i) => {
    const fragment = line.trim();
    if (!fragment || fragment.startsWith('#')) return;
    try {
      new RegExp(fragment, 'iu');
    } catch {
      throw new SafeError(`Line ${i + 1} of the restricted-term list is not a valid regular expression.`);
    }
    fragments.push(`(?:${fragment})`);
  });
  if (fragments.length === 0) return null;
  // Fragments that compile alone can still fail together (too large, clashing
  // groups), and a RegExp SyntaxError quotes the whole pattern, so never let it out.
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${fragments.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  } catch {
    throw new SafeError('The restricted-term list is valid line by line but does not compile as one pattern.');
  }
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

function github(token, fetchImpl) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function request(url, accept) {
    const res = await fetchImpl(url.startsWith('http') ? url : `${API}${url}`, {
      headers: accept ? { ...headers, Accept: accept } : headers,
    });
    if (!res.ok) {
      const err = new SafeError(`GitHub API ${res.status} for ${url.split('?')[0]}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  return {
    json: async url => (await request(url)).json(),
    raw: async url => Buffer.from(await (await request(url, 'application/vnd.github.raw')).arrayBuffer()),
    async paginate(url) {
      const items = [];
      let next = `${url}${url.includes('?') ? '&' : '?'}per_page=100`;
      while (next) {
        const res = await request(next);
        items.push(...(await res.json()));
        next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
      }
      return items;
    },
  };
}

async function scanFiles({ files, matcher, gh, repo, ref, hit, note }) {
  for (const [index, file] of files.entries()) {
    if (file.status === 'removed') continue;
    const pathHit = matcher.test(file.filename);
    const where = pathHit ? `changed file #${index + 1} (path withheld)` : `file ${file.filename}`;
    if (pathHit) hit(`${where}: the file path`);

    let lines;
    if (file.patch !== undefined) {
      lines = addedLines(file.patch);
    } else if (file.changes === 0 || file.status === 'renamed') {
      // A pure rename or mode change has no content diff to check.
      continue;
    } else {
      // GitHub omits the patch for binary files and for diffs it considers too
      // large. Fetch the whole file at the head ref: binary is skipped, anything
      // else is checked in full, since its added lines cannot be isolated.
      let content;
      try {
        const path = file.filename.split('/').map(encodeURIComponent).join('/');
        content = await gh.raw(`/repos/${repo}/contents/${path}?ref=${ref}`);
      } catch (err) {
        note(`${where}: could not fetch content to check (HTTP ${err.status ?? 'error'}).`);
        continue;
      }
      if (isBinary(content)) continue;
      lines = content
        .toString('utf8')
        .split('\n')
        .map((text, i) => ({ line: i + 1, text }));
    }
    for (const { line, text } of lines) {
      if (matcher.test(text)) hit(`${where} line ${line}`);
    }
  }
}

async function scanPullRequest({ event, matcher, gh, repo, hit, incomplete }) {
  const pr = await gh.json(`/repos/${repo}/pulls/${event.pull_request.number}`);
  if (matcher.test(pr.title ?? '')) hit('PR title');
  if (matcher.test(pr.body ?? '')) hit('PR body');
  if (matcher.test(pr.head.ref ?? '')) hit('head branch name');

  if (pr.commits > MAX_PR_COMMITS) {
    incomplete(`The PR has ${pr.commits} commits; the API lists only ${MAX_PR_COMMITS}. Split or squash it.`);
  }
  const commits = await gh.paginate(`/repos/${repo}/pulls/${pr.number}/commits`);
  for (const c of commits) {
    if (matcher.test(c.commit.message ?? '')) hit(`commit ${c.sha.slice(0, 12)} message`);
  }

  if (pr.changed_files > MAX_PR_FILES) {
    incomplete(`The PR changes ${pr.changed_files} files; the API lists only ${MAX_PR_FILES}. Split it.`);
  }
  const files = await gh.paginate(`/repos/${repo}/pulls/${pr.number}/files`);
  await scanFiles({ files, matcher, gh, repo, ref: pr.head.sha, hit, note: incomplete });
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
    if (files.length >= MAX_COMPARE_FILES) {
      incomplete(`The push changes ${MAX_COMPARE_FILES}+ files; only the first ${MAX_COMPARE_FILES} were checked.`);
    }
  } catch (err) {
    // A force push or a new ref has no usable base; fall back to the head commit.
    if (err.status !== 404) throw err;
    const head = await gh.json(`/repos/${repo}/commits/${event.after}`);
    commits = [head];
    files = head.files ?? [];
  }
  for (const c of commits) {
    if (matcher.test(c.commit.message ?? '')) hit(`commit ${c.sha.slice(0, 12)} message`);
  }
  await scanFiles({ files, matcher, gh, repo, ref: event.after, hit, note: incomplete });
  return `push to ${event.ref}: ${commits.length} commit(s), ${files.length} file(s)`;
}

/** Runs the check and returns its exit code; every line it logs is safe to publish. */
export async function run({
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
  readFile = fs.readFileSync,
} = {}) {
  const fail = msg => {
    log(`::error::${msg}`);
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
  const gh = github(env.GITHUB_TOKEN, fetchImpl);
  const repo = env.GITHUB_REPOSITORY;

  const hits = [];
  const gaps = [];
  const ctx = { event, matcher, gh, repo, hit: where => hits.push(where), incomplete: why => gaps.push(why) };

  let summary;
  try {
    if (eventName === 'pull_request_target' || eventName === 'pull_request') {
      summary = await scanPullRequest(ctx);
    } else if (eventName === 'push') {
      summary = await scanPush(ctx);
    } else {
      log(`Nothing to check for ${eventName} events.`);
      return 0;
    }
  } catch (err) {
    return fail(`Restricted-term check could not complete: ${safeMessage(err)}`);
  }

  log(`Checked ${summary}.`);
  const isPush = eventName === 'push';
  for (const why of gaps) log(`${isPush ? '::warning::' : '::error::'}Incomplete check: ${why}`);
  for (const where of hits) log(`::error::Restricted term found in ${where}.`);

  if (hits.length > 0) {
    log(
      `${hits.length} restricted-term hit(s). The matched text is deliberately not shown. ` +
        (isPush
          ? 'This push is already on the branch: a maintainer must follow up.'
          : 'Remove it from the locations above (rewrite commit messages if needed) and push again.')
    );
    return 1;
  }
  if (gaps.length > 0 && !isPush) return 1;
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
