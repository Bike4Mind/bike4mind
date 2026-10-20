#!/usr/bin/env node
// Blocks a maintainer-configured list of restricted terms from PR text and diffs.
//
// The list comes from the RESTRICTED_TERMS secret: one case-insensitive regex
// fragment per line, matched on word boundaries (camelCase humps count as
// boundaries too; see `hasWordEdges`). Blank lines and lines starting with `#` are
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
//                        diff. Fails on any hit.
//   push                 the same for the pushed commits. Main is already
//                        updated by then, so this only reports.
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

// Letters, digits and the two case classes the boundary check needs. They are
// deliberately case-sensitive: under /iu, \p{Lu} also matches lowercase letters,
// so every position would look like a boundary.
const ALNUM = /[\p{L}\p{N}]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const LETTER = /\p{L}/u;

// Read whole characters, not code units: half of an astral character is a lone
// surrogate, which `\p{L}` does not match, so indexing would see a word edge
// where there is none.
function charAt(text, i) {
  return i >= text.length ? '' : String.fromCodePoint(text.codePointAt(i));
}

function charBefore(text, i) {
  if (i <= 0) return '';
  const low = text.charCodeAt(i - 1);
  return low >= 0xdc00 && low <= 0xdfff ? text.slice(i - 2, i) : text.slice(i - 1, i);
}

/** Whether an identifier changes case or switches between letters and digits between `i - 1` and `i`. */
function isHump(text, i) {
  if (i <= 0 || i >= text.length) return false;
  const before = charBefore(text, i);
  const at = charAt(text, i);
  if (!ALNUM.test(before) || !ALNUM.test(at)) return false;
  if (LOWER.test(before) && UPPER.test(at)) return true; // fooBar
  if (UPPER.test(before) && UPPER.test(at) && LOWER.test(charAt(text, i + at.length))) return true; // HTTPServer
  return LETTER.test(before) !== LETTER.test(at); // foo2, 2foo
}

// Word boundaries are letters and digits only, so `_`, `-`, `/` and `.` separate
// words, and a case or letter-digit change inside an identifier does too. A
// fragment that begins or ends with punctuation (`@acme`) supplies its own edge
// there, so that side is not checked.
function hasWordEdges(text, start, match) {
  const end = start + match.length;
  const first = charAt(match, 0);
  const last = charBefore(match, match.length);
  const leftOk =
    !ALNUM.test(first) || start === 0 || !ALNUM.test(charBefore(text, start)) || isHump(text, start);
  const rightOk =
    !ALNUM.test(last) || end === text.length || !ALNUM.test(charAt(text, end)) || isHump(text, end);
  return leftOk && rightOk;
}

/** Folds text and list lines the same way, so an accent or a format character cannot hide a term. */
function fold(s) {
  return s.normalize('NFD').replace(/\p{Cf}|\p{Mn}/gu, '').normalize('NFKC');
}

/**
 * Compiles the term list into a matcher, or throws a message safe to print.
 * The matcher's `test` is boundary-aware (see `hasWordEdges`), so a term matches
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
    let edges;
    try {
      whole = new RegExp(fragment, 'giu');
      // The scan below tries one match at a time and cannot backtrack across `|`
      // alternatives or lazy quantifiers, so also ask the plain pattern, which can.
      edges = new RegExp(`(?<![\\p{L}\\p{N}])(?:${fragment})(?![\\p{L}\\p{N}])`, 'iu');
    } catch {
      throw new SafeError(`Line ${i + 1} of the restricted-term list is not a valid regular expression.`);
    }
    if (whole.test('')) {
      throw new SafeError(`Line ${i + 1} of the restricted-term list matches an empty string, so it would flag every change.`);
    }
    // A longer match at the same start, from `minLength` characters on: the
    // lookbehind makes the engine backtrack into later alternatives and lazy
    // quantifiers to satisfy it. Anchored on the remaining text rather than made
    // sticky, because a sticky match takes the same short branch the caller
    // already rejected.
    const longerAt = (text, start, minLength) =>
      new RegExp(`^(?:${fragment})(?<=[\\s\\S]{${minLength}})`, 'iu').exec(text.slice(start))?.[0];
    fragments.push(text => {
      if (edges.test(text)) return true;
      // Alternation keeps the first branch that completes, so the match the scan
      // finds can be shorter than the one whose edges hold (`acme|acmecorp` on
      // `useAcmecorpClient`, `acme\w*?` on the same text). Walk the longer ones
      // out before giving up on that start.
      let at = 0;
      let match;
      while (at <= text.length) {
        // The pattern is stateful (`g`): every scan starts from the top.
        whole.lastIndex = at;
        match = whole.exec(text);
        if (!match) break;
        let found = match[0];
        for (;;) {
          if (hasWordEdges(text, match.index, found)) return true;
          const longer = longerAt(text, match.index, [...found].length + 1);
          if (!longer) break;
          found = longer;
        }
        // One whole character ahead, so an overlapping match is still seen. Never
        // behind `at`, so a wrong step cannot stall the scan.
        at = Math.max(at + 1, match.index + (text.codePointAt(match.index) > 0xffff ? 2 : 1));
      }
      return false;
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
      if (isBinary(content)) {
        // Binary content is still published with the repository, so scan its
        // printable text rather than skipping it; it has no lines to number. The
        // NUL-stripped view catches UTF-16LE strings, which have a NUL between
        // every character and so never form a printable run on their own.
        const text = content.toString('latin1');
        lines = [text, text.replace(/\0/g, '')]
          .flatMap(view => view.match(/[\x20-\x7e]+/g) ?? [])
          .map(run => ({ text: run }));
      } else {
        lines = content
          .toString('utf8')
          .split('\n')
          .map((text, i) => ({ line: i + 1, text }));
      }
    }
    for (const { line, text } of lines) {
      if (matches(matcher, text)) hit(line === undefined ? `${where} (binary text)` : `${where} line ${line}`);
    }
  }
}

// The net diff misses text one commit adds and a later one removes, yet merge
// and rebase merges put every commit into the base branch's history. So with
// more than one commit, each commit's own diff is checked too. Merge commits are
// skipped: their diff against the first parent is the base branch's history, and
// what they change in the result is already in the net diff.
async function scanCommitDiffs({ commits, matcher, gh, repo, hit, incomplete }) {
  if (commits.length < 2) return;
  for (const c of commits) {
    if ((c.parents?.length ?? 1) > 1) continue;
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
    // A force push or a new ref has no usable base; fall back to the head commit.
    // For a new ref that is the whole push, but after a force push the other
    // commits go unread, which has to be reported as a gap.
    if (err.status !== 404) throw err;
    if (!ZERO_SHA.test(event.before)) {
      incomplete('the push base is not comparable; only the head commit was checked.');
    }
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

/** Runs the check and returns its exit code; every line it logs is safe to publish. */
export async function run({
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
  readFile = fs.readFileSync,
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
  for (const why of gaps) annotate('error', `Incomplete check: ${why}`);
  for (const where of hits) annotate('error', `Restricted term found in ${where}.`);

  if (hits.length > 0) {
    log(
      `${hits.length} restricted-term hit(s). The matched text is deliberately not shown. ` +
        (isPush
          ? 'This push is already on the branch: a maintainer must follow up.'
          : 'Remove it from the locations above (rewrite commit messages if needed) and push again.')
    );
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
