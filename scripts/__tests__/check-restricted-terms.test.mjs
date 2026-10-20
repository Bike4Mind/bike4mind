import { describe, it, expect } from 'vitest';
import { addedLines, compileTerms, matches, run } from '../check-restricted-terms.mjs';

// Invented placeholder terms; the real list lives only in the repository secret.
const TERMS = ['zorblax', 'flim-?flam', '# a comment line', '', 'glorp\\d+'].join('\n');

function response(body, { status = 200, link } = {}) {
  return {
    ok: status < 400,
    status,
    headers: { get: name => (name.toLowerCase() === 'link' ? (link ?? null) : null) },
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer,
  };
}

// Routes are matched on the URL path with the query string removed.
function fakeFetch(routes) {
  return async url => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return response({ message: 'Not Found' }, { status: 404 });
    return typeof route === 'function' ? route(url) : route;
  };
}

const PR_EVENT = { pull_request: { number: 7 } };

function pr(overrides = {}) {
  return {
    number: 7,
    title: 'feat(client): add a widget',
    body: 'Adds a widget.',
    head: { ref: 'feat/widget', sha: 'h'.repeat(40) },
    commits: 1,
    changed_files: 1,
    ...overrides,
  };
}

const commit = (message, sha = 'c'.repeat(40)) => ({ sha, commit: { message } });
const file = (filename, patch, extra = {}) => ({ filename, status: 'modified', changes: 1, patch, ...extra });

const commitRoute = (sha, files) => ({ [`/repos/acme/widgets/commits/${sha}`]: response({ sha, files }) });

async function check({ event = PR_EVENT, eventName = 'pull_request_target', routes, terms = TERMS, token = 'token' }) {
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

  it('does not match an astral letter next to a term, and does not hang on one', () => {
    // One astral letter supplied by the text, one by a fragment that can start on it.
    expect(compileTerms('acme').test('\u{10428}acme')).toBe(false);
    expect(compileTerms('acme').test('acme\u{10428}')).toBe(false);
    expect(compileTerms('\\Wacme').test('\u{1F600}acmez')).toBe(false);
    expect(compileTerms('.acme').test('\u{10428}acmez')).toBe(false);
  });

  it('folds a term that contains a combining mark the same way as the text', () => {
    // Devi: NFD leaves the vowel signs as combining marks, and NFKC cannot compose them.
    expect(compileTerms('\u0939\u093F\u0902\u0926\u0940').test('text \u0939\u093F\u0902\u0926\u0940 here')).toBe(
      true
    );
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
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({ commits: 3 }),
        commits: [commit('add', a), commit('remove', b), { ...commit('merge main', m), parents: [{}, {}] }],
        files: [file('src/a.ts', '@@ -0,0 +1 @@\n+ok')],
        extra: {
          ...commitRoute(a, [file('src/a.ts', '@@ -0,0 +1,2 @@\n+ok\n+zorblax')]),
          ...commitRoute(b, [file('src/a.ts', '@@ -1,2 +1 @@\n ok\n-zorblax')]),
        },
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain(`Restricted term found in commit ${'a'.repeat(12)} file src/a.ts line 2.`);
    expect(output).not.toContain('e'.repeat(12));
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

  it('checks the head commit of a new ref without calling compare or reporting a gap', async () => {
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
    expect(output).not.toContain('Incomplete check');
    expect(output).not.toContain('GitHub API 500');
  });
});
