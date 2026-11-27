import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { addedLines, compileTerms, matches, run } from '../check-restricted-terms.mjs';

// Invented placeholder terms; the real list lives only in the repository secret.
const TERMS = ['zorblax', 'flim-?flam', '# a comment line', '', 'glorp\\d+'].join('\n');

function response(body, { status = 200, link, headers = {} } = {}) {
  const all = { ...headers, ...(link === undefined ? {} : { link }) };
  return {
    ok: status < 400,
    status,
    headers: { get: name => all[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer,
  };
}

// Routes are matched on the URL path with the query string removed.
function fakeFetch(routes) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return response({ message: 'Not Found' }, { status: 404 });
    return typeof route === 'function' ? route(url, init) : route;
  };
}

const PR_EVENT = { pull_request: { number: 7 } };

function pr(overrides = {}) {
  return {
    number: 7,
    title: 'feat(client): add a widget',
    body: 'Adds a widget.',
    base: { sha: '9'.repeat(40) },
    head: { ref: 'feat/widget', sha: 'h'.repeat(40) },
    commits: 1,
    changed_files: 1,
    ...overrides,
  };
}

const commit = (message, sha = 'c'.repeat(40)) => ({ sha, commit: { message } });
const file = (filename, patch, extra = {}) => ({ filename, status: 'modified', changes: 1, patch, ...extra });

const commitRoute = (sha, files) => ({ [`/repos/acme/widgets/commits/${sha}`]: response({ sha, files }) });

// Merge parents need not include the current PR base tip.
const MAIN_TIP = 'f'.repeat(40);
const merge = (message, sha, mergedIn = MAIN_TIP) => ({
  ...commit(message, sha),
  parents: [{ sha: 'p'.repeat(40) }, { sha: mergedIn }],
});
const hashOf = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');

// Every tree the helpers below have built, by sha, so a `?recursive=1` request
// can be answered with the full listing as GitHub would.
const TREES = new Map();
const flatten = (sha, prefix = '') =>
  TREES.get(sha).flatMap(entry => {
    const path = `${prefix}${entry.path}`;
    return [{ ...entry, path }, ...(entry.type === 'tree' ? flatten(entry.sha, `${path}/`) : [])];
  });
const treeRoute = sha => url =>
  response({
    sha,
    tree: new URL(url).searchParams.has('recursive') ? flatten(sha) : TREES.get(sha),
    truncated: false,
  });

// Builds the git tree and blob routes for one version of the repository and
// returns its root tree sha. `node` maps a name to file text or a nested node.
function treeRoutes(routes, node) {
  const tree = Object.entries(node).map(([name, child]) => {
    if (typeof child !== 'string') return { path: name, type: 'tree', sha: treeRoutes(routes, child) };
    const sha = hashOf(child);
    routes[`/repos/acme/widgets/git/blobs/${sha}`] = response({
      sha,
      encoding: 'base64',
      content: Buffer.from(child).toString('base64'),
    });
    return { path: name, type: 'blob', sha };
  });
  const sha = hashOf(tree);
  TREES.set(sha, tree);
  routes[`/repos/acme/widgets/git/trees/${sha}`] = treeRoute(sha);
  return sha;
}

/**
 * Routes the trees of a merge commit and of each parent. `files` maps a path to
 * its text in the merge, then in each parent in order; `undefined` is absent.
 */
function mergeRoutes(mergeCommit, files) {
  const routes = {};
  [mergeCommit.sha, ...mergeCommit.parents.map(parent => parent.sha)].forEach((commitSha, version) => {
    const root = {};
    for (const [path, texts] of Object.entries(files)) {
      if (texts[version] === undefined) continue;
      const parts = path.split('/');
      let node = root;
      for (const dir of parts.slice(0, -1)) node = node[dir] ??= {};
      node[parts.at(-1)] = texts[version];
    }
    routes[`/repos/acme/widgets/git/trees/${commitSha}`] =
      routes[`/repos/acme/widgets/git/trees/${treeRoutes(routes, root)}`];
  });
  return routes;
}

async function check({
  event = PR_EVENT,
  eventName = 'pull_request_target',
  routes,
  terms = TERMS,
  token = 'token',
  sleep = async () => {},
  now = Date.now,
}) {
  const lines = [];
  const code = await run({
    env: {
      RESTRICTED_TERMS: terms,
      GITHUB_TOKEN: token,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: 'event.json',
      GITHUB_REPOSITORY: 'acme/widgets',
    },
    fetchImpl: fakeFetch(routes),
    log: line => lines.push(line),
    readFile: () => JSON.stringify(event),
    sleep,
    now,
  });
  return { code, output: lines.join('\n') };
}

function prRoutes({
  pull = pr(),
  commits = [commit('feat: widget')],
  files = [file('src/a.ts', '@@ -1,0 +1,1 @@\n+ok')],
  extra = {},
} = {}) {
  return {
    '/repos/acme/widgets/pulls/7': response(pull),
    '/repos/acme/widgets/pulls/7/commits': response(commits),
    '/repos/acme/widgets/pulls/7/files': response(files),
    ...extra,
  };
}

describe('compileTerms', () => {
  const m = compileTerms(TERMS);

  it('matches case-insensitively', () => {
    expect(m.test('ZorBlax')).toBe(true);
    expect(m.test('FLIMFLAM')).toBe(true);
  });

  it('matches whole words only', () => {
    expect(m.test('zorblaxian')).toBe(false);
    expect(m.test('prezorblax')).toBe(false);
    expect(m.test('the zorblax engine')).toBe(true);
  });

  it('treats punctuation and underscores as word boundaries', () => {
    for (const text of ['zorblax_helper', 'use-zorblax', 'pkg/zorblax/index.ts', '"zorblax".']) {
      expect(m.test(text), text).toBe(true);
    }
  });

  it('applies regex fragments', () => {
    expect(m.test('flim-flam')).toBe(true);
    expect(m.test('glorp42')).toBe(true);
    expect(m.test('glorp')).toBe(false);
  });

  it('ignores blank and comment lines', () => {
    expect(m.test('a comment line')).toBe(false);
    expect(m.test('')).toBe(false);
  });

  it('catches a term that a shorter list line is a prefix of, in either order', () => {
    for (const terms of ['acme\nacmecorp', 'acmecorp\nacme']) {
      const prefix = compileTerms(terms);
      expect(prefix.test('src/acmecorp/client.ts'), terms).toBe(true);
      expect(prefix.test('we ship acmecorp today'), terms).toBe(true);
      expect(prefix.test('useAcmecorpClient'), terms).toBe(true);
      expect(prefix.test('acmecorp'), terms).toBe(true);
    }
  });

  it('backtracks across alternatives and lazy quantifiers inside one line', () => {
    expect(compileTerms('acme|acmecorp').test('acmecorp')).toBe(true);
    expect(compileTerms('acme\\w*?').test('acmecorp')).toBe(true);
    // The first branch to complete is not always the one whose edges hold.
    const alternative = compileTerms('acme|acmecorp');
    expect(alternative.test('useAcmecorpClient')).toBe(true);
    expect(alternative.test('acmecorp2')).toBe(true);
    expect(compileTerms('acme\\w*?').test('useAcmecorpClient')).toBe(true);
  });

  it('rejects a line that can match nothing, naming only its line number', () => {
    expect(() => compileTerms('zorblax\n(acme)?')).toThrow(
      /^Line 2 of the restricted-term list matches an empty string/
    );
    try {
      compileTerms('zorblax\n(acme)?');
    } catch (err) {
      expect(err.message).not.toContain('acme');
    }
  });

  it('backtracks to shorter matches without changing anchor or lookbehind context', () => {
    for (const fragment of ['acme(corp)?', 'acmecorp|acme']) {
      const matcher = compileTerms(fragment);
      expect(matcher.test('AcmeCorporation'), fragment).toBe(true);
      expect(matcher.test('src/AcmeCorporation/client.ts'), fragment).toBe(true);
      expect(matcher.test('preacmecorporation'), fragment).toBe(false);
    }
    expect(compileTerms('(?<=use)acme|(?<=use)acmecorp').test('useAcmecorpClient')).toBe(true);
    expect(compileTerms('^acme|^acmecorp').test('useAcmecorpClient')).toBe(false);
    expect(compileTerms('acme$|acmecorp$').test('useAcmecorpClient')).toBe(false);
  });

  it('rejects contextual zero-width matches instead of reporting them as terms', () => {
    for (const fragment of ['\\b', '(?=x)', '(?<=x)']) {
      expect(() => compileTerms(`zorblax\n${fragment}`).test('x')).toThrow(
        /^Line 2 of the restricted-term list matches an empty string/
      );
    }
  });

  it('does not match an astral letter next to a term, and does not hang on one', () => {
    // One astral letter supplied by the text, one by a fragment that can start on it.
    expect(compileTerms('acme').test('\u{10428}acme')).toBe(false);
    expect(compileTerms('acme').test('acme\u{10428}')).toBe(false);
    expect(compileTerms('\\Wacme').test('\u{1F600}acmez')).toBe(false);
    expect(compileTerms('.acme').test('\u{10428}acmez')).toBe(false);
  });

  it('reads an astral character whole on either edge, and one inside the match', () => {
    // U+10428 is an astral lowercase letter, U+10400 an astral uppercase one.
    // A lone surrogate half would look like punctuation here, so each side is
    // checked with a letter on the other side of it.
    expect(compileTerms('\u{10400}b').test('A\u{10400}b')).toBe(true);
    expect(compileTerms('acme').test('\u{10428}Acme')).toBe(true);
    expect(compileTerms('.acme').test('x\u{10428}acme')).toBe(false);
    expect(compileTerms('acme.').test('acme\u{10428}z')).toBe(false);
  });

  it('folds a term that contains a combining mark the same way as the text', () => {
    // Devi: NFD leaves the vowel signs as combining marks, and NFKC cannot compose them.
    expect(compileTerms('\u0939\u093F\u0902\u0926\u0940').test('text \u0939\u093F\u0902\u0926\u0940 here')).toBe(true);
    // A halfwidth voiced sound mark only becomes a combining mark at NFKC.
    expect(compileTerms('acmecorp').test('acme\u{FF9E}corp')).toBe(true);
  });

  it('returns null for an empty list', () => {
    expect(compileTerms(undefined)).toBeNull();
    expect(compileTerms('\n  \n# only a comment\n')).toBeNull();
  });

  it('reports an invalid fragment by line number without echoing it', () => {
    expect(() => compileTerms('zorblax\nbad(frag')).toThrow(/^Line 2 of the restricted-term list is not a valid/);
    try {
      compileTerms('zorblax\nbad(frag');
    } catch (err) {
      expect(err.message).not.toContain('bad(frag');
    }
  });
});

describe('matches', () => {
  const m = compileTerms(TERMS);

  it('treats camelCase humps and letter-digit changes as boundaries', () => {
    for (const text of ['useZorblaxClient', 'ZorblaxClient', 'HTTPZorblax', 'zorblax2', 'myFlimflam']) {
      expect(matches(m, text), text).toBe(true);
    }
  });

  it('still requires a whole word', () => {
    for (const text of ['Zorblaxian', 'prezorblax', 'zorblaxian2']) {
      expect(matches(m, text), text).toBe(false);
    }
  });

  it('sees through fullwidth letters and invisible format characters', () => {
    expect(matches(m, '\uFF5A\uFF4F\uFF52\uFF42\uFF4C\uFF41\uFF58')).toBe(true);
    expect(matches(m, 'zor\u200Bblax')).toBe(true);
    expect(matches(m, 'zor\u00ADblax')).toBe(true);
  });

  it('sees through combining marks stacked on each letter', () => {
    expect(matches(m, 'z\u0336o\u0336r\u0336b\u0336l\u0336a\u0336x\u0336')).toBe(true);
  });

  it('matches a term that itself has a case or digit boundary inside an identifier', () => {
    const identifier = compileTerms('acme2\nacmecorp');
    expect(identifier.test('src/acme2Client.ts')).toBe(true);
    expect(identifier.test('useAcmeCorpClient')).toBe(true);
    expect(identifier.test('ACME2_SERVER')).toBe(true);
  });

  it('matches a fragment that starts or ends with punctuation next to a letter', () => {
    const punctuation = compileTerms('@acme\nacme-');
    expect(punctuation.test('user@acme.com')).toBe(true);
    expect(punctuation.test('acme-x')).toBe(true);
    // A punctuation edge only covers its own side; the other one still has to hold.
    expect(punctuation.test('user@acmecorp.com')).toBe(false);
    expect(compileTerms('@acme@').test('a@acme@b')).toBe(true);
  });

  it('folds fragments the same way as the text they are matched against', () => {
    expect(compileTerms('cafe\u0301').test('caf\u00E9')).toBe(true);
    expect(compileTerms('caf\u00E9').test('cafe\u0301')).toBe(true);
  });
});

describe('addedLines', () => {
  it('returns only added lines, numbered in the new file', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' keep',
      '-gone',
      '+new one',
      ' keep',
      '+new two',
      '@@ -20,1 +21,2 @@',
      ' ctx',
      '+late',
    ].join('\n');
    expect(addedLines(patch)).toEqual([
      { line: 2, text: 'new one' },
      { line: 4, text: 'new two' },
      { line: 22, text: 'late' },
    ]);
  });

  it('ignores the no-newline marker', () => {
    expect(addedLines('@@ -0,0 +1 @@\n+only\n\\ No newline at end of file')).toEqual([{ line: 1, text: 'only' }]);
  });
});

describe('run', () => {
  it('fails with a maintainer-facing message when the secret is missing', async () => {
    const { code, output } = await check({ terms: '', routes: prRoutes() });
    expect(code).toBe(1);
    expect(output).toContain('RESTRICTED_TERMS secret is missing or empty');
  });

  it('fails on a list line that can match nothing, without echoing it', async () => {
    const { code, output } = await check({ terms: 'zorblax\n(flim)?', routes: prRoutes() });
    expect(code).toBe(1);
    expect(output).toContain('Line 2 of the restricted-term list matches an empty string');
    expect(output).not.toContain('flim');
  });

  it('passes a clean PR', async () => {
    const { code, output } = await check({ routes: prRoutes() });
    expect(code).toBe(0);
    expect(output).toContain('No restricted terms found.');
  });

  it('reports every location without echoing the matched text', async () => {
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({
          title: 'feat: Zorblax support',
          body: 'adds flim-flam',
          head: { ref: 'feat/zorblax', sha: 'h'.repeat(40) },
        }),
        commits: [commit('wire up glorp9', 'a'.repeat(40)), commit('clean', 'b'.repeat(40))],
        extra: { ...commitRoute('a'.repeat(40), []), ...commitRoute('b'.repeat(40), []) },
        files: [
          file('src/a.ts', '@@ -1,2 +1,3 @@\n keep\n+const x = "zorblax";\n-zorblax was here\n keep'),
          file('src/zorblax.ts', '@@ -0,0 +1,1 @@\n+fine', { status: 'added' }),
        ],
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain('Restricted term found in PR title.');
    expect(output).toContain('Restricted term found in PR body.');
    expect(output).toContain('Restricted term found in head branch name.');
    expect(output).toContain(`Restricted term found in commit ${'a'.repeat(12)} message.`);
    expect(output).not.toContain('b'.repeat(12));
    expect(output).toContain('Restricted term found in file src/a.ts line 2.');
    expect(output).toContain('Restricted term found in changed file #2 (path withheld): the file path.');
    expect(output.toLowerCase()).not.toMatch(/zorblax|flim|glorp/);
  });

  it('escapes a newline in a reported path so it cannot inject a workflow command', async () => {
    const { code, output } = await check({
      routes: prRoutes({ files: [file('src/a\n::stop-commands::x.ts', '@@ -0,0 +1 @@\n+zorblax')] }),
    });
    expect(code).toBe(1);
    expect(output).toContain('file src/a%0A::stop-commands::x.ts line 1');
    expect(output.split('\n').some(line => line.startsWith('::stop-commands::'))).toBe(false);
  });

  it("checks each commit's own diff, so text added and later removed is caught", async () => {
    const [a, b, m] = ['a'.repeat(40), 'b'.repeat(40), 'e'.repeat(40)];
    const mergeCommit = merge('merge main', m);
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 3 }),
        commits: [commit('add', a), commit('remove', b), mergeCommit],
        files: [file('src/a.ts', '@@ -0,0 +1 @@\n+ok')],
        extra: {
          ...commitRoute(a, [file('src/a.ts', '@@ -0,0 +1,2 @@\n+ok\n+zorblax')]),
          ...commitRoute(b, [file('src/a.ts', '@@ -1,2 +1 @@\n ok\n-zorblax')]),
          ...mergeRoutes(mergeCommit, { 'src/a.ts': ['ok', 'ok', undefined] }),
        },
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain(`Restricted term found in commit ${'a'.repeat(12)} file src/a.ts line 2.`);
    expect(output).not.toContain('e'.repeat(12));
  });

  it('checks a merge resolution even when a later commit removes its added term', async () => {
    const [mergeSha, removal] = ['e'.repeat(40), 'b'.repeat(40)];
    const mergeCommit = merge('merge', mergeSha);
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 2 }),
        commits: [mergeCommit, commit('remove', removal)],
        extra: {
          ...mergeRoutes(mergeCommit, { 'src/a.ts': ['zorblax', 'ok', 'fine'] }),
          ...commitRoute(removal, [file('src/a.ts', '@@ -1 +0,0 @@\n-zorblax')]),
        },
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain(`Restricted term found in commit ${mergeSha.slice(0, 12)} file src/a.ts line 1.`);
    expect(output).not.toContain('zorblax');
  });

  it('checks only the lines a merge resolution adds beyond both parents', async () => {
    const mergeSha = 'e'.repeat(40);
    const mergeCommit = merge('merge main', mergeSha);
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 2 }),
        commits: [commit('feat'), mergeCommit],
        extra: {
          ...commitRoute('c'.repeat(40), []),
          ...mergeRoutes(mergeCommit, {
            // Line 2 comes from main and line 3 from the PR; only line 4 is new in the merge.
            'src/deep/a.ts': [
              'keep\nmain says zorblax\npr says flim-flam\nresolved with glorp9',
              'keep\npr says flim-flam',
              'keep\nmain says zorblax',
            ],
            'src/deep/b.ts': ['zorblax', 'zorblax', 'fine'],
            'src/other.ts': ['fine', 'fine', 'fine'],
          }),
        },
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain(`Restricted term found in commit ${mergeSha.slice(0, 12)} file src/deep/a.ts line 4.`);
    expect(output.match(/Restricted term found/g)).toHaveLength(1);
    expect(output.toLowerCase()).not.toMatch(/zorblax|flim|glorp/);
  });

  it('reports a path only a merge introduces, and withholds an inherited one', async () => {
    const mergeSha = 'e'.repeat(40);
    const mergeCommit = merge('merge main', mergeSha);
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 2 }),
        commits: [commit('feat'), mergeCommit],
        extra: {
          ...commitRoute('c'.repeat(40), []),
          ...mergeRoutes(mergeCommit, {
            'src/zorblax.ts': ['fine', undefined, undefined],
            'docs/glorp1.md': ['resolved', 'ours', 'theirs'],
          }),
        },
      }),
    });
    expect(code).toBe(1);
    expect(output).toMatch(/Restricted term found in commit e{12} merged file #\d \(path withheld\): the file path\./);
    expect(output.match(/Restricted term found/g)).toHaveLength(1);
    expect(output.toLowerCase()).not.toMatch(/zorblax|glorp/);
  });

  it('checks a merge in a PR with more files than compare lists, without charging either side', async () => {
    const mergeSha = 'e'.repeat(40);
    const mergeCommit = merge('merge main', mergeSha);
    const files = {};
    for (let i = 0; i < 400; i++) {
      files[`src/pr/f${i}.ts`] = [`pr ${i}`, `pr ${i}`, undefined];
      // Main's own content, terms included, is not the PR's to answer for.
      files[`src/main/f${i}.ts`] = [`zorblax ${i}`, undefined, `zorblax ${i}`];
    }
    files['src/shared.ts'] = ['pr side\nmain side\nresolved flim-flam', 'pr side', 'main side'];
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 2, changed_files: 401 }),
        commits: [commit('feat'), mergeCommit],
        extra: { ...commitRoute('c'.repeat(40), []), ...mergeRoutes(mergeCommit, files) },
      }),
    });
    expect(output).not.toContain('Incomplete check');
    expect(output).toContain(`Restricted term found in commit ${mergeSha.slice(0, 12)} file src/shared.ts line 3.`);
    expect(output.match(/Restricted term found/g)).toHaveLength(1);
    expect(code).toBe(1);
  });

  it('fails closed when a merged directory is too large to list', async () => {
    const mergeSha = 'e'.repeat(40);
    const mergeCommit = merge('merge main', mergeSha);
    const routes = mergeRoutes(mergeCommit, { 'src/a.ts': ['resolved', 'ours', 'theirs'] });
    const rootPath = `/repos/acme/widgets/git/trees/${mergeSha}`;
    const listRoot = routes[rootPath];
    routes[rootPath] = async url => response({ ...(await listRoot(url).json()), truncated: true });
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 2 }),
        commits: [commit('feat'), mergeCommit],
        extra: { ...commitRoute('c'.repeat(40), []), ...routes },
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain(`Incomplete check: merge ${mergeSha.slice(0, 12)} has a directory too large to list.`);
  });

  it("does not charge a merge of the base branch with the base branch's own changes", async () => {
    const [a, m] = ['a'.repeat(40), 'e'.repeat(40)];
    const mergeCommit = merge('merge main', m);
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 2 }),
        commits: [commit('feat', a), mergeCommit],
        extra: {
          ...commitRoute(a, [file('src/a.ts', '@@ -0,0 +1 @@\n+ok')]),
          // The first-parent diff carries a term main added; the merge itself adds nothing.
          ...commitRoute(m, [file('docs/main.md', '@@ -0,0 +1 @@\n+zorblax')]),
          ...mergeRoutes(mergeCommit, {
            'src/a.ts': ['ok', 'ok', undefined],
            'docs/main.md': ['zorblax', undefined, 'zorblax'],
          }),
        },
      }),
    });
    expect(output).not.toContain('Restricted term found');
    expect(code).toBe(0);
  });

  it.each([
    ['an older side branch', ['p'.repeat(40), 's'.repeat(40)]],
    ['an octopus merge', ['p'.repeat(40), MAIN_TIP, 's'.repeat(40)]],
  ])('does not charge main content inherited before merging %s', async (_description, parents) => {
    const [feature, mergeSha] = ['a'.repeat(40), 'e'.repeat(40)];
    const mergeCommit = { ...merge('merge side branch', mergeSha), parents: parents.map(sha => ({ sha })) };
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 2 }),
        commits: [commit('feature', feature), mergeCommit],
        extra: {
          ...commitRoute(feature, []),
          // Main's term is inherited by the first parent, but absent from the older side branch.
          ...mergeRoutes(mergeCommit, {
            'docs/main.md': ['zorblax', 'zorblax', ...parents.slice(1).map(() => undefined)],
            'src/a.ts': ['ok', undefined, ...parents.slice(1).map(() => 'ok')],
          }),
        },
      }),
    });
    expect(output).not.toContain('Restricted term found');
    expect(code).toBe(0);
  });

  it('checks a push merge resolution before a later commit removes it', async () => {
    const [before, mergeSha, removal] = ['1'.repeat(40), 'e'.repeat(40), '2'.repeat(40)];
    const event = { ref: 'refs/heads/main', before, after: removal };
    const mergeCommit = merge('merge side branch', mergeSha, before);
    const { code, output } = await check({
      eventName: 'push',
      event,
      routes: {
        [`/repos/acme/widgets/compare/${before}...${removal}`]: response({
          commits: [mergeCommit, commit('remove', removal)],
          files: [],
        }),
        ...mergeRoutes(mergeCommit, { 'src/a.ts': ['zorblax', 'ok', 'fine'] }),
        ...commitRoute(removal, [file('src/a.ts', '@@ -1 +0,0 @@\n-zorblax')]),
      },
    });
    expect(code).toBe(1);
    expect(output).toContain(`Restricted term found in commit ${mergeSha.slice(0, 12)} file src/a.ts line 1.`);
    expect(output).not.toContain('zorblax');
  });

  it('does not charge a push merge with content already on the pushed branch', async () => {
    const [before, mergeSha, after] = ['1'.repeat(40), 'e'.repeat(40), '2'.repeat(40)];
    const event = { ref: 'refs/heads/main', before, after };
    const mergeCommit = merge('merge side branch', mergeSha);
    const { code, output } = await check({
      eventName: 'push',
      event,
      routes: {
        [`/repos/acme/widgets/compare/${before}...${after}`]: response({
          commits: [mergeCommit, commit('feature', after)],
          files: [],
        }),
        // The term is already on the merged-in branch, so the merge adds nothing.
        ...mergeRoutes(mergeCommit, { 'docs/main.md': ['zorblax', undefined, 'zorblax'] }),
        ...commitRoute(after, []),
      },
    });
    expect(output).not.toContain('Restricted term found');
    expect(code).toBe(0);
  });

  it('checks a single merge through the net PR diff', async () => {
    const mergeSha = 'e'.repeat(40);
    const { code, output } = await check({
      routes: prRoutes({
        commits: [merge('merge main', mergeSha)],
        files: [file('src/a.ts', '@@ -0,0 +1 @@\n+zorblax')],
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain('Restricted term found in file src/a.ts line 1.');
    expect(output).not.toContain('could not complete');
    expect(output).not.toContain('zorblax');
  });

  it.each([404, 500])('fails closed when the merge tree returns HTTP %s', async status => {
    const mergeSha = 'e'.repeat(40);
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 2 }),
        commits: [commit('feature'), merge('merge main', mergeSha)],
        extra: {
          ...commitRoute('c'.repeat(40), []),
          [`/repos/acme/widgets/git/trees/${mergeSha}`]: response({}, { status }),
        },
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain(`could not complete: GitHub API ${status}`);
    expect(output).not.toContain('No restricted terms found');
  });

  it('reports contextual zero-width configuration errors without echoing the pattern', async () => {
    const { code, output } = await check({
      terms: 'zorblax\n(?=widget)',
      routes: prRoutes({ pull: pr({ title: 'widget' }) }),
    });
    expect(code).toBe(1);
    expect(output).toContain('Line 2 of the restricted-term list matches an empty string');
    expect(output).not.toContain('widget');
    expect(output).not.toContain('Restricted term found');
  });

  it('ignores removed lines', async () => {
    const { code } = await check({ routes: prRoutes({ files: [file('src/a.ts', '@@ -1,1 +0,0 @@\n-zorblax')] }) });
    expect(code).toBe(0);
  });

  it('follows pagination', async () => {
    const routes = prRoutes();
    routes['/repos/acme/widgets/pulls/7/files'] = url =>
      url.includes('page=2')
        ? response([file('src/b.ts', '@@ -0,0 +1 @@\n+zorblax')])
        : response([file('src/a.ts', '@@ -0,0 +1 @@\n+ok')], {
            link: '<https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=2>; rel="next"',
          });
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('file src/b.ts line 1');
  });

  it('checks a large text file in full and scans a binary file instead of skipping it', async () => {
    const routes = prRoutes({
      files: [file('big.txt', undefined, { changes: 5000 }), file('img.png', undefined, { changes: 10 })],
    });
    routes['/repos/acme/widgets/contents/big.txt'] = response('line one\nzorblax here');
    routes['/repos/acme/widgets/contents/img.png'] = {
      ...response(''),
      arrayBuffer: async () => new Uint8Array([0x89, 0, ...new TextEncoder().encode('zorblax')]).buffer,
    };
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('file big.txt line 2');
    expect(output).toContain('file img.png (binary text)');
    expect(output.toLowerCase()).not.toContain('zorblax');
  });

  it('scans short terms and UTF-16LE text in a binary file', async () => {
    const routes = prRoutes({
      files: [file('short.bin', undefined, { changes: 10 }), file('utf16.bin', undefined, { changes: 10 })],
    });
    routes['/repos/acme/widgets/contents/short.bin'] = {
      ...response(''),
      arrayBuffer: async () => new Uint8Array([0, ...new TextEncoder().encode('glp'), 0]).buffer,
    };
    routes['/repos/acme/widgets/contents/utf16.bin'] = {
      ...response(''),
      arrayBuffer: async () => new Uint8Array([0x89, 0, ...new TextEncoder().encode('z\0o\0r\0b\0l\0a\0x\0')]).buffer,
    };
    const { code, output } = await check({ terms: 'glp', routes });
    expect(code).toBe(1);
    expect(output).toContain('file short.bin (binary text)');

    const utf16 = await check({ routes });
    expect(utf16.code).toBe(1);
    expect(utf16.output).toContain('file utf16.bin (binary text)');
  });

  it('folds Unicode readable text inside binary files', async () => {
    for (const text of ['\uFF5A\uFF4F\uFF52\uFF42\uFF4C\uFF41\uFF58', 'zor\u200Bblax', 'z\u00F3rblax']) {
      const routes = prRoutes({ files: [file('data.bin', undefined)] });
      routes['/repos/acme/widgets/contents/data.bin'] = response(`\0${text}\0`);
      const { code, output } = await check({ routes });
      expect(code, text).toBe(1);
      expect(output).toContain('file data.bin (binary text)');
      expect(output).not.toContain(text);
    }
  });

  it('checks an added file whose patch is omitted', async () => {
    const routes = prRoutes({ files: [file('data.txt', undefined, { status: 'added', changes: 0 })] });
    routes['/repos/acme/widgets/contents/data.txt'] = response('zorblax');
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('file data.txt line 1');
  });

  it('withholds a path that contains a term with a digit in it', async () => {
    const { code, output } = await check({
      terms: 'acme2',
      routes: prRoutes({ files: [file('src/acme2Client.ts', '@@ -0,0 +1 @@\n+// acme2 here')] }),
    });
    expect(code).toBe(1);
    expect(output).toContain('changed file #1 (path withheld): the file path');
    expect(output).toContain('changed file #1 (path withheld) line 1');
    expect(output).not.toContain('acme2Client');
  });

  it('fails without echoing the body when an API response is not JSON', async () => {
    const routes = prRoutes();
    routes['/repos/acme/widgets/pulls/7/files'] = {
      ...response(null),
      json: async () => JSON.parse('<html>zorblax</html>'),
    };
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('could not complete: unexpected SyntaxError.');
    expect(output.toLowerCase()).not.toContain('zorblax');
  });

  it('fails closed when the PR is too large to list completely', async () => {
    const { code, output } = await check({ routes: prRoutes({ pull: pr({ changed_files: 3001 }) }) });
    expect(code).toBe(1);
    expect(output).toContain('Incomplete check');
  });

  it('fails closed when the PR has more commits than the API lists', async () => {
    const { code, output } = await check({ routes: prRoutes({ pull: pr({ commits: 251 }) }) });
    expect(code).toBe(1);
    expect(output).toContain('::error::Incomplete check: The PR has 251 commits; the API lists only 250.');
  });

  it('fails closed when one commit changes more files than the API lists', async () => {
    const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
    const many = Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}.txt`, status: 'removed' }));
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 2 }),
        commits: [commit('one', a), commit('two', b)],
        extra: { ...commitRoute(a, many), ...commitRoute(b, []) },
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain(`Incomplete check: commit ${a.slice(0, 12)} changes 3000+ files`);
  });

  it('fails closed when a file without a patch cannot be fetched', async () => {
    const routes = prRoutes({ files: [file('big.txt', undefined, { changes: 5000 })] });
    routes['/repos/acme/widgets/contents/big.txt'] = response({ message: 'Not Found' }, { status: 404 });
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('Incomplete check: file big.txt: could not fetch content to check (HTTP 404).');
  });

  it('fails closed when there is no GITHUB_TOKEN', async () => {
    const { code, output } = await check({ routes: prRoutes(), token: '' });
    expect(code).toBe(1);
    expect(output).toContain('GITHUB_TOKEN is not set.');
  });

  it('fetches a renamed and edited file in full when its patch is omitted', async () => {
    const routes = prRoutes({ files: [file('big.txt', undefined, { status: 'renamed', changes: 5000 })] });
    routes['/repos/acme/widgets/contents/big.txt'] = response('zorblax');
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('file big.txt line 1');
  });

  it('skips a pure rename', async () => {
    const { code } = await check({
      routes: prRoutes({ files: [file('moved.txt', undefined, { status: 'renamed', changes: 0 })] }),
    });
    expect(code).toBe(0);
  });

  it('fetches an entry with no counted changes whose status is not a rename', async () => {
    const routes = prRoutes({ files: [file('run.sh', undefined, { status: 'modified', changes: 0 })] });
    routes['/repos/acme/widgets/contents/run.sh'] = response('zorblax');
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('file run.sh line 1');
  });

  it('fails a push whose commits the compare API could not all list', async () => {
    const event = { ref: 'refs/heads/main', before: '1'.repeat(40), after: '2'.repeat(40) };
    const routes = {
      [`/repos/acme/widgets/compare/${event.before}...${event.after}`]: response({
        total_commits: 251,
        commits: [commit('chore: ok', 'd'.repeat(40))],
        files: [],
      }),
    };
    const { code, output } = await check({ eventName: 'push', event, routes });
    expect(code).toBe(1);
    expect(output).toContain('::error::Incomplete check: The push has 251 commits');
  });

  it('checks commit messages and added lines of a push', async () => {
    const event = { ref: 'refs/heads/main', before: '1'.repeat(40), after: '2'.repeat(40) };
    const routes = {
      [`/repos/acme/widgets/compare/${event.before}...${event.after}`]: response({
        commits: [commit('fix: Flim-Flam', 'd'.repeat(40))],
        files: [file('src/c.ts', '@@ -0,0 +1 @@\n+ok')],
      }),
    };
    const { code, output } = await check({ eventName: 'push', event, routes });
    expect(code).toBe(1);
    expect(output).toContain(`commit ${'d'.repeat(12)} message`);
    expect(output).toContain('already on the branch');
    expect(output.toLowerCase()).not.toContain('flim');
  });

  it('fails a push that changes more files than compare lists', async () => {
    const event = { ref: 'refs/heads/main', before: '1'.repeat(40), after: '2'.repeat(40) };
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.txt`, status: 'removed' }));
    const routes = {
      [`/repos/acme/widgets/compare/${event.before}...${event.after}`]: response({
        commits: [commit('chore: ok', 'd'.repeat(40))],
        files,
      }),
    };
    const { code, output } = await check({ eventName: 'push', event, routes });
    expect(code).toBe(1);
    expect(output).toContain('Incomplete check: The push changes 300+ files');
  });

  it('fails a push when compare errors instead of falling back to the head commit', async () => {
    const event = { ref: 'refs/heads/main', before: '1'.repeat(40), after: '2'.repeat(40) };
    const routes = {
      [`/repos/acme/widgets/compare/${event.before}...${event.after}`]: response({}, { status: 500 }),
    };
    const { code, output } = await check({ eventName: 'push', event, routes });
    expect(code).toBe(1);
    expect(output).toContain('could not complete: GitHub API 500');
    expect(output).not.toContain('Checked push');
  });

  it('reports the unread commits when a push base cannot be compared', async () => {
    const event = { ref: 'refs/heads/main', before: '1'.repeat(40), after: '2'.repeat(40) };
    const routes = {
      [`/repos/acme/widgets/commits/${event.after}`]: response({
        ...commit('fix: zorblax', event.after),
        files: [file('src/a.ts', '@@ -0,0 +1 @@\n+zorblax')],
      }),
    };
    const { code, output } = await check({ eventName: 'push', event, routes });
    expect(code).toBe(1);
    expect(output).toContain('Incomplete check: the push base is not comparable');
    expect(output).toContain('Restricted term found in file src/a.ts line 1.');
    expect(output).toContain(`Restricted term found in commit ${event.after.slice(0, 12)} message.`);
    expect(output).toContain('already on the branch');
  });

  it('checks the head of a new ref and reports that earlier history was not read', async () => {
    const event = { ref: 'refs/heads/main', before: '0'.repeat(40), after: '2'.repeat(40) };
    const routes = {
      [`/repos/acme/widgets/compare/${event.before}...${event.after}`]: response({}, { status: 500 }),
      [`/repos/acme/widgets/commits/${event.after}`]: response({
        ...commit('fix: zorblax', event.after),
        files: [file('src/a.ts', '@@ -0,0 +1 @@\n+zorblax')],
      }),
    };
    const { code, output } = await check({ eventName: 'push', event, routes });
    expect(code).toBe(1);
    expect(output).toContain('Restricted term found in file src/a.ts line 1.');
    expect(output).toContain(`Restricted term found in commit ${event.after.slice(0, 12)} message.`);
    expect(output).toContain('Incomplete check: the new ref history was not listed');
    expect(output).not.toContain('GitHub API 500');
  });

  it('fails closed for a clean new-ref head whose earlier history was not read', async () => {
    const event = { ref: 'refs/heads/main', before: '0'.repeat(40), after: '2'.repeat(40) };
    const routes = {
      [`/repos/acme/widgets/commits/${event.after}`]: response({ ...commit('clean', event.after), files: [] }),
    };
    const { code, output } = await check({ eventName: 'push', event, routes });
    expect(code).toBe(1);
    expect(output).toContain('Incomplete check: the new ref history was not listed');
  });
});

describe('comment events', () => {
  const COMMENT_URL = 'https://github.com/acme/widgets/pull/7#issuecomment-11';
  const issueComment = (body, { onPullRequest = true, login = 'reviewer' } = {}) => ({
    action: 'created',
    issue: { number: 7, ...(onPullRequest ? { pull_request: { url: 'https://api.github.com/x' } } : {}) },
    comment: { id: 11, body, html_url: COMMENT_URL, user: { login } },
  });
  const review = (body, state = 'commented', login = 'reviewer') => ({
    action: 'submitted',
    pull_request: { number: 7 },
    review: {
      id: 12,
      body,
      state,
      html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-12',
      user: { login },
    },
  });
  const reviewComment = body => ({
    action: 'created',
    pull_request: { number: 7 },
    comment: {
      id: 13,
      body,
      html_url: 'https://github.com/acme/widgets/pull/7#discussion_r13',
      user: { login: 'reviewer' },
    },
  });

  // Records the nudge requests; `existing` seeds the PR's comment list.
  function nudgeRoutes(existing = []) {
    const sent = [];
    const record = (url, init) => {
      sent.push({ method: init?.method, path: new URL(url).pathname, body: JSON.parse(init.body) });
      return response({ id: 99 });
    };
    const routes = {
      '/repos/acme/widgets/issues/7/comments': (url, init) =>
        init?.method === 'POST' ? record(url, init) : response(existing),
    };
    for (const c of existing) routes[`/repos/acme/widgets/issues/comments/${c.id}`] = record;
    return { routes, sent };
  }

  it('fails on a PR comment that contains a term and posts one nudge without echoing the text', async () => {
    const { routes, sent } = nudgeRoutes();
    const { code, output } = await check({
      eventName: 'issue_comment',
      event: issueComment('this leaks zorblax, see glorp42'),
      routes,
    });
    expect(code).toBe(1);
    expect(output).toContain(`Restricted term found in comment by @reviewer (${COMMENT_URL}).`);
    expect(output).toContain('Posted a nudge comment on the PR.');
    expect(output.toLowerCase()).not.toMatch(/zorblax|glorp/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/repos/acme/widgets/issues/7/comments' });
    expect(sent[0].body.body).toContain('<!-- restricted-terms-nudge -->');
    expect(sent[0].body.body).toContain(`[comment](${COMMENT_URL}) by @reviewer`);
    expect(sent[0].body.body.toLowerCase()).not.toMatch(/zorblax|glorp/);
  });

  it('updates the existing nudge instead of posting a second one', async () => {
    const { routes, sent } = nudgeRoutes([
      { id: 5, user: { login: 'someone' }, body: '<!-- restricted-terms-nudge --> pasted by a human' },
      { id: 6, user: { login: 'github-actions[bot]' }, body: '<!-- restricted-terms-nudge -->\nold nudge' },
    ]);
    const { code } = await check({
      eventName: 'pull_request_review_comment',
      event: reviewComment('flim-flam'),
      routes,
    });
    expect(code).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'PATCH', path: '/repos/acme/widgets/issues/comments/6' });
    expect(sent[0].body.body).toContain('[review comment](https://github.com/acme/widgets/pull/7#discussion_r13)');
  });

  it('passes a clean comment and posts nothing', async () => {
    const { routes, sent } = nudgeRoutes();
    const { code, output } = await check({ eventName: 'issue_comment', event: issueComment('looks good'), routes });
    expect(code).toBe(0);
    expect(output).toContain('No restricted terms found.');
    expect(sent).toHaveLength(0);
  });

  it('checks a review summary and withholds a login that is itself a term', async () => {
    const { routes, sent } = nudgeRoutes();
    const { code, output } = await check({
      eventName: 'pull_request_review',
      event: review('please drop the zorblax bit', 'changes_requested', 'zorblax'),
      routes,
    });
    expect(code).toBe(1);
    expect(output).toContain(
      'Restricted term found in review (https://github.com/acme/widgets/pull/7#pullrequestreview-12).'
    );
    expect(output.toLowerCase()).not.toMatch(/zorblax/);
    expect(sent[0].body.body.toLowerCase()).not.toMatch(/zorblax/);
  });

  it('skips a comment on an issue that is not a pull request', async () => {
    const { routes, sent } = nudgeRoutes();
    const { code, output } = await check({
      eventName: 'issue_comment',
      event: issueComment('zorblax', { onPullRequest: false }),
      routes,
    });
    expect(code).toBe(0);
    expect(output).toContain('Nothing to check: the comment is on an issue, not a pull request.');
    expect(output.toLowerCase()).not.toMatch(/zorblax/);
    expect(sent).toHaveLength(0);
  });

  it('skips a review submitted with inline comments only, whose body is empty', async () => {
    const { routes, sent } = nudgeRoutes();
    const { code, output } = await check({ eventName: 'pull_request_review', event: review('', 'commented'), routes });
    expect(code).toBe(0);
    expect(output).toContain('Nothing to check: the review has no text.');
    expect(sent).toHaveLength(0);
  });

  it('still fails, with a warning, when the nudge cannot be posted', async () => {
    const { code, output } = await check({
      eventName: 'issue_comment',
      event: issueComment('zorblax'),
      routes: { '/repos/acme/widgets/issues/7/comments': response({ message: 'Forbidden' }, { status: 403 }) },
    });
    expect(code).toBe(1);
    expect(output).toContain('::warning::Could not post the nudge comment on the PR: GitHub API 403');
    expect(output.toLowerCase()).not.toMatch(/zorblax/);
  });
});

describe('merge tree listing', () => {
  const mergeSha = 'e'.repeat(40);
  const mergeCommit = merge('merge main', mergeSha);
  const mergeFiles = {
    'src/deep/nested/a.ts': ['ok\nzorblax', 'ok', 'ok\nfine'],
    'src/deep/b.ts': ['same', 'same', 'same'],
  };

  // Records every git/trees request, so a test can assert how the walk listed them.
  function recordTrees(routes) {
    const requested = [];
    for (const [path, route] of Object.entries(routes)) {
      if (!path.includes('/git/trees/')) continue;
      routes[path] = url => {
        requested.push(url);
        return typeof route === 'function' ? route(url) : route;
      };
    }
    return requested;
  }

  const mergePr = extra =>
    prRoutes({
      pull: pr({ commits: 2 }),
      commits: [commit('feat'), mergeCommit],
      extra: { ...commitRoute('c'.repeat(40), []), ...extra },
    });

  it('lists each root tree once, recursively, instead of one request per directory', async () => {
    const routes = mergeRoutes(mergeCommit, mergeFiles);
    const requested = recordTrees(routes);
    const { code, output } = await check({ routes: mergePr(routes) });
    expect(output).toContain(
      `Restricted term found in commit ${mergeSha.slice(0, 12)} file src/deep/nested/a.ts line 2.`
    );
    expect(code).toBe(1);
    expect(requested).toHaveLength(3);
    expect(requested.every(url => new URL(url).searchParams.get('recursive') === '1')).toBe(true);
  });

  it('falls back to per-directory listing when a recursive listing is truncated', async () => {
    const routes = mergeRoutes(mergeCommit, mergeFiles);
    const rootPath = `/repos/acme/widgets/git/trees/${mergeSha}`;
    const listRoot = routes[rootPath];
    routes[rootPath] = async url =>
      new URL(url).searchParams.has('recursive')
        ? response({ ...(await listRoot(url).json()), truncated: true })
        : listRoot(url);
    const requested = recordTrees(routes);
    const { code, output } = await check({ routes: mergePr(routes) });
    expect(output).not.toContain('Incomplete check');
    expect(output).toContain(
      `Restricted term found in commit ${mergeSha.slice(0, 12)} file src/deep/nested/a.ts line 2.`
    );
    expect(code).toBe(1);
    expect(requested.some(url => !new URL(url).searchParams.has('recursive'))).toBe(true);
  });
});

describe('GitHub API rate limits', () => {
  const NOW = 1_800_000_000_000;

  // Answers the PR route with `limited` responses in turn, then the real PR.
  function flakyPr(...limited) {
    const routes = prRoutes();
    const ok = routes['/repos/acme/widgets/pulls/7'];
    let calls = 0;
    routes['/repos/acme/widgets/pulls/7'] = () => limited[calls++] ?? ok;
    return { routes, calls: () => calls };
  }

  async function checkWithClock(routes) {
    const waits = [];
    const result = await check({ routes, now: () => NOW, sleep: async ms => void waits.push(ms) });
    return { ...result, waits };
  }

  it('waits until an exhausted primary limit resets, then retries', async () => {
    const reset = String(NOW / 1000 + 30);
    const { routes } = flakyPr(
      response(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
        }
      )
    );
    const { code, output, waits } = await checkWithClock(routes);
    expect(waits).toEqual([31_000]);
    expect(code).toBe(0);
    expect(output).toContain('No restricted terms found.');
  });

  it.each([403, 429])('honours retry-after on HTTP %s', async status => {
    const { routes } = flakyPr(response({}, { status, headers: { 'retry-after': '5' } }));
    const { code, waits } = await checkWithClock(routes);
    expect(waits).toEqual([5000]);
    expect(code).toBe(0);
  });

  it('backs off on a secondary limit that only says so in its message', async () => {
    const { routes } = flakyPr(response({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 }));
    const { code, waits } = await checkWithClock(routes);
    expect(waits).toEqual([60_000]);
    expect(code).toBe(0);
  });

  it('fails fast on a 403 that is not a rate limit', async () => {
    const { routes, calls } = flakyPr(response({ message: 'Resource not accessible by integration' }, { status: 403 }));
    const { code, output, waits } = await checkWithClock(routes);
    expect(waits).toEqual([]);
    expect(calls()).toBe(1);
    expect(code).toBe(1);
    expect(output).toContain('could not complete: GitHub API 403 for /repos/acme/widgets/pulls/7');
    expect(output).not.toContain('rate limit');
  });

  it('fails now, naming the rate limit, when the reset is too far off to wait for', async () => {
    const reset = String(NOW / 1000 + 40 * 60);
    const { routes, calls } = flakyPr(
      response({}, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })
    );
    const { code, output, waits } = await checkWithClock(routes);
    expect(waits).toEqual([]);
    expect(calls()).toBe(1);
    expect(code).toBe(1);
    expect(output).toContain(
      'GitHub API 403 for /repos/acme/widgets/pulls/7: rate limit exceeded, retry in about 41 min.'
    );
  });

  it('gives up after a bounded number of retries', async () => {
    const limited = response({}, { status: 429, headers: { 'retry-after': '10' } });
    const { routes, calls } = flakyPr(...Array(10).fill(limited));
    const { code, output, waits } = await checkWithClock(routes);
    expect(waits).toEqual([10_000, 10_000, 10_000]);
    expect(calls()).toBe(4);
    expect(code).toBe(1);
    expect(output).toContain('GitHub API 429 for /repos/acme/widgets/pulls/7: rate limit exceeded');
  });

  it('caps the total wait across requests', async () => {
    const limited = response({}, { status: 429, headers: { 'retry-after': '80' } });
    const { routes } = flakyPr(limited, limited, limited);
    const { code, waits } = await checkWithClock(routes);
    expect(waits).toEqual([80_000, 80_000]);
    expect(code).toBe(1);
  });
});
